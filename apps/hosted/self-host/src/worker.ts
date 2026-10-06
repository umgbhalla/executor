/** Product Worker. One durable actor owns PostgreSQL, auth, sessions and background work. */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DurableObjectState, Fetcher } from "@cloudflare/workers-types";
import { PGlite } from "@electric-sql/pglite";
import { PgliteClient } from "@effect/sql-pglite";
import { ConfigProvider, Effect, Exit, Layer, Schema, Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { selfHostDatabaseSchema } from "./implementation/database-schema.ts";
import type { HttpBinding } from "./implementation/workerd/bindings.ts";
import { prepareProduct as prepareSharedProduct, type ProductOptions } from "./product.ts";
import {
  prepareProductFilesystem,
  completeProductBootstrap,
} from "./implementation/workerd/storage-migration.ts";
import pgliteWasmModule from "executor:pglite.wasm";
import initdbWasmModule from "executor:initdb.wasm";
import pgliteData from "executor:pglite.data";

interface ProductStub {
  fetch(request: Request): Promise<Response>;
  workflow(request: Request): Promise<Response>;
  exportDatabase(): Promise<Response>;
}
export interface ProductEnvironment {
  readonly PRODUCT: { getByName(name: string): ProductStub };
  readonly LEGACY_DATABASE: HttpBinding;
  readonly NATIVE: HttpBinding;
  readonly BLOBS: HttpBinding;
  readonly DASHBOARD: HttpBinding;
  readonly PUBLIC_FETCH: HttpBinding;
  readonly PRIVATE_FETCH: HttpBinding;
  /** This product's own `SelfOrigin` entrypoint, for requests to the dashboard origin. */
  readonly SELF: HttpBinding;
  readonly APPS: Fetcher;
}
export { AuthDatabase } from "./contracts/database.ts";

const configuration = (native: HttpBinding) =>
  Effect.tryPromise({
    try: async () => {
      const response = await native.fetch(new Request("http://native.internal/configuration"));
      if (!response.ok) throw new Error("Cannot read host configuration");
      return response.json();
    },
    catch: () => new Error("Cannot read host configuration"),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))));

/** Reuse the private hosted product while each host supplies its own capabilities. */
export const prepareProduct = (
  state: DurableObjectState,
  env: ProductEnvironment,
  options: Omit<ProductOptions, "database" | "exportDatabase"> & {
    readonly databaseSchema?: Layer.Layer<
      Layer.Success<typeof selfHostDatabaseSchema>,
      unknown,
      Layer.Services<typeof selfHostDatabaseSchema>
    >;
    readonly database?: ProductOptions["database"];
  } = {},
) =>
  Effect.gen(function* () {
    const persistence =
      options.database === undefined
        ? yield* Effect.gen(function* () {
            const fs = yield* prepareProductFilesystem(state.storage, env.LEGACY_DATABASE);
            const pg = yield* Effect.acquireRelease(
              Effect.tryPromise(async () => {
                const pg = new PGlite({
                  fs,
                  pgliteWasmModule,
                  initdbWasmModule,
                  fsBundle: new Blob([pgliteData]),
                  parsers: { 1082: (value) => value, 1114: (value) => value },
                });
                await pg.waitReady;
                return pg;
              }),
              (pg) => Effect.promise(() => pg.close()),
            );
            yield* completeProductBootstrap(state.storage);
            return {
              layer: (options.databaseSchema ?? selfHostDatabaseSchema).pipe(
                Layer.provideMerge(PgliteClient.layer({ liveClient: pg })),
              ),
              exportDatabase: async () =>
                new Response(await pg.dumpDataDir("none"), {
                  headers: { "content-type": "application/x-tar" },
                }),
            };
          })
        : {
            layer: options.database,
            exportDatabase: async () => new Response(null, { status: 404 }),
          };
    return yield* prepareSharedProduct(env, {
      ...options,
      database: persistence.layer,
      exportDatabase: persistence.exportDatabase,
    });
  });

/**
 * The product store has its own disk service, namespace and migration journal.
 *
 * Opening it runs schema migrations and data steps, which can take longer on a large install than
 * workerd allows a `blockConcurrencyWhile` callback: after 30 seconds workerd cancels the callback
 * and resets the object. So the store opens outside it, and every entry point waits for the open
 * product instead. Nothing is served, built or run in the background before the open finishes.
 */
export class ExecutorProduct extends DurableObject<ProductEnvironment> implements ProductStub {
  readonly #state: DurableObjectState;
  readonly #env: ProductEnvironment;
  #opening: Promise<Effect.Success<ReturnType<typeof prepareProduct>>> | undefined;
  constructor(state: DurableObjectState, env: ProductEnvironment) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    // Start at once, as after a restart; a failure is reported to the events that wait for it.
    this.#product().catch(() => undefined);
  }
  /** The open product. A failed open releases what it acquired, and the next event retries it. */
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
      const config = await Effect.runPromise(configuration(this.#env.NATIVE));
      const product = await Effect.runPromise(
        prepareProduct(this.#state, this.#env).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
      await this.#state.storage.setAlarm(Date.now() + 30_000);
      return product;
    } catch {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw new Error(
        "Executor product storage could not open. The original PostgreSQL directory has been preserved.",
      );
    }
  }
  /** Dispatch the existing authenticated product routes. */
  async fetch(request: Request): Promise<Response> {
    return (await this.#product()).fetch(request);
  }
  /** Private workflow callbacks are reached only through the named service entrypoint. */
  async workflow(request: Request): Promise<Response> {
    return (await this.#product()).workflow(request);
  }
  /** The offline export process owns the volume lock; no public socket serves this method. */
  async exportDatabase(): Promise<Response> {
    return (await this.#product()).exportDatabase();
  }
  /** Restore the background owner after a restart even when no public request arrives. */
  async alarm(): Promise<void> {
    await this.#product();
    await this.#state.storage.setAlarm(Date.now() + 30_000);
  }
}

/** Private service binding used by the workerd workflow engine. */
export class WorkflowCallbacks extends WorkerEntrypoint<ProductEnvironment> {
  async fetch(request: Request): Promise<Response> {
    return this.env.PRODUCT.getByName("product").workflow(request);
  }
}

/**
 * Requests this instance sends to its own dashboard origin, from app isolates or host egress.
 * They never cross the network, so they carry a fixed internal source instead of any client
 * address header the sender supplied.
 */
export class SelfOrigin extends WorkerEntrypoint<ProductEnvironment> {
  async fetch(request: Request): Promise<Response> {
    const internal = new Request(request);
    internal.headers.set("x-executor-client-ip", "127.0.0.1");
    return this.env.PRODUCT.getByName("product").fetch(internal);
  }
}

/** Only the offline supervisor binds a socket to this entrypoint. */
export class ProductExport extends WorkerEntrypoint<ProductEnvironment> {
  async fetch(): Promise<Response> {
    return this.env.PRODUCT.getByName("product").exportDatabase();
  }
}

/** Public traffic can only reach the product's authenticated route map. */
export default {
  fetch(request: Request, env: ProductEnvironment): Promise<Response> {
    return env.PRODUCT.getByName("product").fetch(request);
  },
};
