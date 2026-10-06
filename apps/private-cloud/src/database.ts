/** Private product SQL and auth share one Hyperdrive-backed PostgreSQL database. */
import { PgClient } from "@effect/sql-pg";
import { AuthDatabase } from "@executor-js/hosted-self-host/worker";
import { Effect, Layer, Redacted } from "effect";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

export const privateHostedDatabase = (connectionString: string) =>
  Layer.effect(
    AuthDatabase,
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Kysely<unknown>({
              dialect: new PostgresDialect({
                pool: new Pool({ connectionString, max: 2, idleTimeoutMillis: 30_000 }),
              }),
            }),
        ),
        (db) => Effect.promise(() => db.destroy()),
      );
      const database = AuthDatabase.of({ db, type: "postgres", transaction: true });
      return database;
    }),
  ).pipe(
    Layer.provideMerge(
      PgClient.layer({ url: Redacted.make(connectionString), maxConnections: 3, prepare: false }),
    ),
  );
