/** Shared hosted product composition. Each host supplies its own SQL engine and platform. */
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { executorSkillFiles } from "@executor-js/app-templates/executor";
import { bindingWorkerdApps } from "@executor-js/sdk/workerd";
import type { Executor } from "@executor-js/sdk/core";
import { ScheduleHostReady } from "@executor-js/sdk/scheduling";
import { telemetryConfig, telemetryLayer } from "@executor-js/telemetry";
import { urlPolicyConfig } from "@executor-js/utils/url-policy";
import { Config, Context, Effect, Layer, Option, Scope } from "effect";
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { AuthDatabase } from "./contracts/database.ts";
import {
  selfHostExecutorServices,
  SelfHostWorkflowRequests,
  type SelfHostPlatform,
} from "./implementation/executor-services.ts";
import { selfHostRouteMap } from "./implementation/routes.ts";
import {
  bindingBlobStore,
  bindingDashboard,
  bindingHttpClient,
  bindingRepositories,
} from "./implementation/workerd/bindings.ts";
import type { ProductEnvironment } from "./worker.ts";
import skills from "executor:skills";
import dashboard from "executor:dashboard";

export { AuthDatabase };
export type { ProductEnvironment } from "./worker.ts";

export interface ProductOptions {
  readonly auth?: Parameters<typeof selfHostRouteMap>[0]["auth"];
  readonly localTelemetry?: boolean;
  readonly appHostnameMode?: "single-label";
  readonly database: Layer.Layer<AuthDatabase | SqlClient.SqlClient, unknown, never>;
  readonly exportDatabase?: () => Promise<Response>;
  readonly platform?: (
    executor: Effect.Effect<Executor>,
  ) => Effect.Effect<SelfHostPlatform, unknown, Scope.Scope>;
}

export const prepareProduct = (env: ProductEnvironment, options: ProductOptions) =>
  Effect.gen(function* () {
    const persistence = {
      layer: options.database,
      exportDatabase: options.exportDatabase ?? (async () => new Response(null, { status: 404 })),
    };
    if (yield* Config.Boolean("EXECUTOR_STORAGE_EXPORT").pipe(Config.withDefault(false)))
      return {
        fetch: async (_request: Request) => new Response(null, { status: 503 }),
        workflow: async (_request: Request) => new Response(null, { status: 503 }),
        exportDatabase: persistence.exportDatabase,
      };
    const telemetry = yield* telemetryConfig("executor-selfhost");
    const common = yield* Layer.build(
      Layer.mergeAll(
        persistence.layer,
        telemetryLayer(
          options.localTelemetry !== false &&
            telemetry.traces === undefined &&
            telemetry.logs === undefined
            ? {
                ...telemetry,
                traces: { url: "http://127.0.0.1:4318/v1/traces" },
                logs: { url: "http://127.0.0.1:4318/v1/logs" },
              }
            : telemetry,
        ),
        HttpServer.layerServices,
        BrowserCrypto.layer,
        Layer.succeed(ScheduleHostReady, Effect.void),
      ),
    );
    return yield* Effect.gen(function* () {
      const policy = yield* urlPolicyConfig;
      const egress = {
        policy,
        client: yield* bindingHttpClient(policy, env.PUBLIC_FETCH, env.PRIVATE_FETCH, {
          origin: yield* Config.String("BETTER_AUTH_URL"),
          binding: env.SELF,
        }),
      };
      const blobs = bindingBlobStore(env.BLOBS);
      const directory = yield* Config.NonEmptyString("EXECUTOR_REPOSITORIES_DIR");
      const services = yield* Layer.build(
        selfHostExecutorServices(
          egress,
          options.platform ??
            (() =>
              Effect.gen(function* () {
                const host = yield* bindingWorkerdApps({
                  binding: env.APPS,
                  authorization: "service-binding",
                  blobs,
                });
                return { ...host, blobs, repositories: bindingRepositories(env.NATIVE, directory) };
              })),
        ),
      );
      const routes = yield* selfHostRouteMap({
        skills: executorSkillFiles(skills),
        egress,
        ...(options.appHostnameMode === undefined
          ? {}
          : { appHostnameMode: options.appHostnameMode }),
        executorServices: Layer.succeedContext(services),
        dashboard: bindingDashboard(env.DASHBOARD, dashboard),
        ...(options.auth === undefined ? {} : { auth: options.auth }),
      });
      const http = yield* HttpRouter.toHttpEffect(routes).pipe(
        Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
      );
      const workflow = Context.get(services, SelfHostWorkflowRequests);
      const context = yield* Effect.context<never>();
      const addressed = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* http.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            request.modify({
              remoteAddress: Option.fromUndefinedOr(request.headers["x-executor-client-ip"]),
            }),
          ),
        );
      });
      return {
        fetch: HttpEffect.toWebHandlerWith<never, Effect.Services<typeof addressed>>(context)(
          addressed,
        ),
        workflow: HttpEffect.toWebHandlerWith<never, Effect.Services<typeof workflow>>(context)(
          workflow,
        ),
        exportDatabase: persistence.exportDatabase,
      };
    }).pipe(Effect.provideContext(common));
  });
