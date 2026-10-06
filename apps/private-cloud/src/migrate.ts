/** Run this before a Worker deploy. The direct database URL belongs to the migration job. */
import { PgClient } from "@effect/sql-pg";
import { migrateHostedDatabase } from "@executor-js/hosted-server/migrations";
import { Config, Effect, Redacted } from "effect";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { privateAuthOptions, privateAuthSettings } from "./implementation/auth-options.ts";

export const migratePrivateDatabase = Effect.scoped(
  Effect.gen(function* () {
    const url = yield* Config.Redacted("DATABASE_URL");
    const settings = yield* privateAuthSettings;
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: Redacted.value(url), max: 2 })),
      (pool) => Effect.promise(() => pool.end()),
    );
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const database = { db, type: "postgres" as const, transaction: true as const };
    yield* migrateHostedDatabase({
      ...privateAuthOptions(settings, []),
      database,
      secret: Redacted.value(settings.secret),
    }).pipe(Effect.provide(PgClient.layer({ url, maxConnections: 1, prepare: false })));
  }),
);
