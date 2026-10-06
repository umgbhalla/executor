/** Private product composition. Hyperdrive owns SQL; this actor owns coordination. */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Artifacts, DurableObjectState } from "@cloudflare/workers-types";
import { RegistryError } from "@executor-js/app-registry";
import { prepareProduct, type ProductEnvironment } from "@executor-js/hosted-self-host/product";
import { ConfigProvider, Effect, Exit, Redacted, Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { privateHostedAuth } from "./auth.ts";
import { privateHostedDatabase } from "./database.ts";
import { privateApps, type AppEnvironment } from "./apps.ts";
import { r2Blobs } from "./blobs.ts";
import { privateRepositories } from "./sources.ts";
import { privateWorkflows } from "./workflows.ts";

export { AppDataSupervisor, AppRunner } from "./apps.ts";
export { AppWorkflows } from "./workflows.ts";

interface Environment extends AppEnvironment {
  APP_WORKFLOWS: Parameters<typeof privateWorkflows>[0]["APP_WORKFLOWS"];
  PRODUCT: ProductEnvironment["PRODUCT"];
  ASSETS: ProductEnvironment["DASHBOARD"];
  ARTIFACTS: Artifacts;
  CLOUDFLARE_ACCOUNT_ID: string;
  ARTIFACTS_NAMESPACE: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  EXECUTOR_ENCRYPTION_KEY: string;
  EXECUTOR_PAIRING_KEY: string;
  EXECUTOR_APP_UI_BASE_URL?: string;
  HYPERDRIVE: { readonly connectionString: string };
}

const unavailable = { fetch: async () => new Response(null, { status: 404 }) };
const productBindings = (env: Environment): ProductEnvironment => ({
  PRODUCT: env.PRODUCT,
  LEGACY_DATABASE: { fetch: async () => Response.json([]) },
  NATIVE: unavailable,
  BLOBS: unavailable,
  DASHBOARD: env.ASSETS,
  // Both use the native fetch service. Its stricter request declarations differ from DOM types.
  PUBLIC_FETCH: env.APP_OUTBOUND as unknown as ProductEnvironment["PUBLIC_FETCH"],
  PRIVATE_FETCH: env.APP_OUTBOUND as unknown as ProductEnvironment["PRIVATE_FETCH"],
  SELF: { fetch: (request) => env.PRODUCT.getByName("product").fetch(request) },
  APPS: env.APP_OUTBOUND,
});

export class ExecutorProduct extends DurableObject<Environment> {
  #opening: Promise<Effect.Success<ReturnType<typeof prepareProduct>>> | undefined;
  constructor(state: DurableObjectState, env: Environment) {
    super(state, env);
  }
  #product() {
    this.#opening ??= this.#open().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }
  async #open() {
    const scope = Scope.makeUnsafe();
    try {
      const configuration: Record<string, string> = {
        BETTER_AUTH_URL: this.env.BETTER_AUTH_URL,
        BETTER_AUTH_SECRET: this.env.BETTER_AUTH_SECRET,
        EXECUTOR_ENCRYPTION_KEY: this.env.EXECUTOR_ENCRYPTION_KEY,
        EXECUTOR_PAIRING_KEY: this.env.EXECUTOR_PAIRING_KEY,
        EXECUTOR_REPOSITORIES_DIR: "artifacts",
        DO_NOT_TRACK: "1",
        ...(this.env.EXECUTOR_APP_UI_BASE_URL === undefined
          ? {}
          : { EXECUTOR_APP_UI_BASE_URL: this.env.EXECUTOR_APP_UI_BASE_URL }),
      };
      const product = await Effect.runPromise(
        prepareProduct(productBindings(this.env), {
          auth: privateHostedAuth,
          localTelemetry: false,
          appHostnameMode: "single-label",
          database: privateHostedDatabase(this.env.HYPERDRIVE.connectionString),
          platform: () =>
            Effect.gen({ self: this }, function* () {
              const repositories = yield* privateRepositories({
                binding: this.env.ARTIFACTS,
                storage: this.ctx.storage,
                accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
                namespace: this.env.ARTIFACTS_NAMESPACE,
                encryptionKey: Redacted.make(this.env.EXECUTOR_ENCRYPTION_KEY),
              });
              const runtime = yield* privateApps(this.env);
              return {
                repositories,
                runtime,
                blobs: r2Blobs(this.env.APP_BUILDS),
                workflows: privateWorkflows(this.env),
                registry: {
                  origin: this.env.BETTER_AUTH_URL,
                  list: () => Effect.succeed([]),
                  snapshot: () => Effect.fail(new RegistryError({ reason: "not-found" })),
                },
              };
            }),
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(configuration))),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return product;
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }
  }
  async fetch(request: Request) {
    return (await this.#product()).fetch(request);
  }
  async workflow(request: Request) {
    return (await this.#product()).workflow(request);
  }
  async exportDatabase() {
    return (await this.#product()).exportDatabase();
  }
  async alarm() {
    await this.#product();
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }
}

/** Only private service bindings can call workflow host operations. */
export class WorkflowCallbacks extends WorkerEntrypoint<Environment> {
  fetch(request: Request) {
    return this.env.PRODUCT.getByName("product").workflow(request);
  }
}

export default {
  fetch(request: Request, env: Environment) {
    const internal = new Request(request);
    internal.headers.set(
      "x-executor-client-ip",
      request.headers.get("cf-connecting-ip") ?? "127.0.0.1",
    );
    return env.PRODUCT.getByName("product").fetch(internal);
  },
};
