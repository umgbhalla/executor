/** Private Cloudflare host. Authored code receives only per-call capabilities. */
import * as Workers from "cloudflare:workers";
import type {
  ExecutionContext,
  Fetcher,
  R2Bucket,
  WorkerLoader,
  WebSocket,
} from "@cloudflare/workers-types";
import { Cause, Effect, Queue, Schema, Stream } from "effect";
import {
  FacetBundle,
  FacetInvocation,
  makeFacetSupervisor,
} from "@executor-js/app-data/cloudflare";
import {
  BlobStore,
  BuildId,
  RuntimeAppsDependencyMissing,
  RuntimeBuildFailed,
  RuntimeProtocolFailed,
  RuntimeProtocolUnsupported,
  SourceFiles,
  runtimeAdapter,
} from "@executor-js/sdk/core";
import {
  appRuntime,
  assembleWorkerBundle,
  credentialFetch,
  credentialKey,
  loadWorkerBuild,
  makeAppRunner,
  remoteAppRunner,
  retainWorkerBuild,
  serveAppRunner,
  workerBuildAsset,
  WorkerBundle,
  WorkerFramework,
  RetainedWorkerBuild,
  type RemoteCapabilities,
} from "@executor-js/sdk/workerd";
import { DeclaredRequirements, HostResponse } from "apps/contracts";
import { r2Blobs } from "./blobs.ts";

export const CompileResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({
      bundle: Schema.toType(WorkerBundle),
      framework: WorkerFramework,
      protocol: RetainedWorkerBuild.fields.protocol,
      ui: Schema.UndefinedOr(
        Schema.Array(
          Schema.Struct({
            path: Schema.String,
            contentType: Schema.String,
            body: Schema.Uint8Array,
          }),
        ),
      ),
    }),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Union([
      RuntimeBuildFailed,
      RuntimeProtocolUnsupported,
      RuntimeAppsDependencyMissing,
    ]),
  }),
]);

export interface AppEnvironment {
  APP_LOADER: Pick<WorkerLoader, "get">;
  APP_DATA: {
    getByName(app: string): Pick<AppDataSupervisor, "invoke" | "cancel" | "cache"> & Fetcher;
  };
  APP_RUNNER: {
    invoke(input: string, capabilities: RemoteCapabilities): Promise<string>;
    declare(bundle: string, headers: Readonly<Record<string, string>>): Promise<string>;
  };
  APP_COMPILER: { compile(files: SourceFiles): Promise<typeof CompileResult.Encoded> };
  APP_BUILDS: R2Bucket;
  APP_CREDENTIAL_KEY: string;
  APP_OUTBOUND: Fetcher;
}

type Callback = ((input: unknown) => Promise<unknown>) | null;
const outbound = (app: string): Fetcher => {
  // Native loopback exports bind props that authored Workers cannot replace.
  const entrypoints = Reflect.get(Workers, "exports") as {
    AppRunner(options: { props: { appOutbound: string } }): Fetcher;
  };
  return entrypoints.AppRunner({ props: { appOutbound: app } });
};

export class AppDataSupervisor extends Workers.DurableObject<AppEnvironment> {
  private readonly supervisor = Effect.runPromise(
    makeFacetSupervisor(this.ctx, this.env.APP_LOADER, outbound),
  );
  async invoke(
    input: typeof FacetInvocation.Type,
    load: () => Promise<typeof FacetBundle.Type>,
    elicit: Callback = null,
    controls: Callback = null,
  ) {
    return Effect.runPromise((await this.supervisor).invoke(input, load, elicit, controls));
  }
  async cancel(id: string) {
    return Effect.runPromise((await this.supervisor).cancel(id));
  }
  async cache(namespace: string, command: unknown) {
    return Effect.runPromise((await this.supervisor).cache(namespace, command));
  }
  async evaluated(command: unknown) {
    return Effect.runPromise((await this.supervisor).evaluated(command));
  }
  async alarm() {
    return Effect.runPromise((await this.supervisor).recover);
  }
  async fetch(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 404 });
    const Pair = Reflect.get(
      globalThis,
      "WebSocketPair",
    ) as typeof import("@cloudflare/workers-types").WebSocketPair;
    const pair = new Pair();
    await Effect.runPromise((await this.supervisor).subscribe(pair[1]));
    const NativeResponse =
      Response as unknown as typeof import("@cloudflare/workers-types").Response;
    return new NativeResponse(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage() {}
  webSocketClose(socket: WebSocket) {
    socket.close(1000, "Closed");
  }
  webSocketError(socket: WebSocket) {
    socket.close(1011, "Reconnect");
  }
}

export class AppRunner extends Workers.WorkerEntrypoint<AppEnvironment> {
  private runner() {
    return serveAppRunner(
      makeAppRunner({
        loader: this.env.APP_LOADER,
        outbound,
        credentialKey: credentialKey(this.env.APP_CREDENTIAL_KEY),
        waitUntil: (task) => this.ctx.waitUntil(task),
        data: (app) => {
          const target = this.env.APP_DATA.getByName(app);
          const attempt = <A>(work: () => Promise<A>) =>
            Effect.tryPromise({ try: work, catch: (error) => error });
          return {
            invoke: (...args) => attempt(() => target.invoke(...args)),
            cancel: (id) => attempt(() => target.cancel(id)),
            cache: (namespace, command) => attempt(() => target.cache(namespace, command)),
          };
        },
      }),
    );
  }
  invoke(input: string, capabilities: RemoteCapabilities) {
    return Effect.runPromise(this.runner().invoke(input, capabilities));
  }
  declare(bundle: string, headers: Readonly<Record<string, string>>) {
    return Effect.runPromise(this.runner().declare(bundle, headers));
  }
  async fetch(request: Request) {
    const props = this.ctx.props as { appOutbound?: string };
    if (typeof props.appOutbound !== "string") return new Response(null, { status: 404 });
    return credentialFetch(request, {
      app: props.appOutbound,
      key: await Effect.runPromise(credentialKey(this.env.APP_CREDENTIAL_KEY)),
      send: async (request) =>
        (await this.env.APP_OUTBOUND.fetch(
          request as unknown as import("@cloudflare/workers-types").Request,
        )) as unknown as Response,
    });
  }
}

const dataChanges = (env: AppEnvironment, app: string) =>
  Stream.callback<number, RuntimeProtocolFailed>(
    (queue) =>
      Effect.gen(function* () {
        const socket = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const response = await env.APP_DATA.getByName(app).fetch(
                "https://data.internal/changes",
                { headers: { upgrade: "websocket" } },
              );
              if (response.status !== 101 || response.webSocket === null)
                throw new Error("Subscription unavailable");
              return response.webSocket;
            },
            catch: () => new RuntimeProtocolFailed(),
          }),
          (socket) => Effect.sync(() => socket.close(1000, "Complete")),
        );
        const fail = () => Queue.failCauseUnsafe(queue, Cause.fail(new RuntimeProtocolFailed()));
        const changed = (event: { data: string | ArrayBuffer }) => {
          try {
            Queue.offerUnsafe(
              queue,
              Schema.decodeUnknownSync(
                Schema.fromJsonString(Schema.Struct({ revision: Schema.Int })),
              )(event.data).revision,
            );
          } catch {
            fail();
          }
        };
        socket.addEventListener("message", changed);
        socket.addEventListener("close", fail);
        socket.addEventListener("error", fail);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            socket.removeEventListener("message", changed);
            socket.removeEventListener("close", fail);
            socket.removeEventListener("error", fail);
          }),
        );
        socket.accept();
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

export const privateApps = (env: AppEnvironment, _ctx: ExecutionContext) =>
  Effect.gen(function* () {
    const blobs = r2Blobs(env.APP_BUILDS);
    const remote = remoteAppRunner({
      invoke: (input, capabilities) =>
        Effect.tryPromise(() => env.APP_RUNNER.invoke(input, capabilities)),
      declare: (bundle, headers) =>
        Effect.tryPromise(() => env.APP_RUNNER.declare(bundle, headers)),
    });
    const runtime = yield* appRuntime({
      name: "runtime.private-cloud",
      loadBuild: loadWorkerBuild,
      invoke: remote.invoke,
      asset: ({ build, path }) => workerBuildAsset(build, path),
      changes: (app) => dataChanges(env, app),
      build: ({ files }) =>
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise({
            try: () => env.APP_COMPILER.compile(files),
            catch: () => new RuntimeBuildFailed({ stage: "compile" }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "50 seconds",
              orElse: () =>
                Effect.fail(
                  new RuntimeBuildFailed({
                    stage: "compile",
                    message: "Compiler did not answer within 50 seconds.",
                  }),
                ),
            }),
            Effect.flatMap(Schema.decodeUnknownEffect(CompileResult)),
            Effect.catchTag("SchemaError", () =>
              Effect.fail(new RuntimeBuildFailed({ stage: "compile" })),
            ),
          );
          if (!result.ok) return yield* result.error;
          const { bundle, framework, protocol, ui } = result.value;
          const envelope = yield* remote
            .declare({ ...assembleWorkerBundle(bundle, framework), protocol }, {})
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(HostResponse)),
              Effect.mapError(() => new RuntimeBuildFailed({ stage: "declaration" })),
            );
          if (!envelope.ok)
            return yield* new RuntimeBuildFailed({
              stage: "declaration",
              message: "App requirements were rejected.",
            });
          const requirements = yield* Schema.decodeUnknownEffect(DeclaredRequirements)(
            envelope.value,
          ).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "declaration" })));
          const build = BuildId.make(`bld_${crypto.randomUUID()}`);
          const stored = yield* retainWorkerBuild(
            build,
            { ...bundle, protocol, database: requirements.database !== undefined },
            framework,
            ui,
          ).pipe(Effect.provideService(BlobStore, blobs));
          return {
            build,
            requirements,
            ...(stored.record.ui === undefined ? {} : { ui: stored.record.ui }),
          };
        }),
    });
    return runtimeAdapter(runtime);
  });
