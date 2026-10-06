/** Shared auth and product schema initialization over an acquired SQL client. */
import { selfHostAuthOptions, selfHostAuthSettings } from "./auth-options.ts";
import { migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import { authSettings } from "@executor-js/hosted-server";
import type { BetterAuthOptions } from "better-auth";
import { Effect, Layer, Redacted } from "effect";
import { AuthDatabase } from "../contracts/database.ts";
import { makeAuthDatabase } from "./auth-database.ts";
/** Acquire one engine and initialize both schemas before exposing services. */
export const selfHostDatabaseSchema = hostedDatabaseSchema(
  selfHostAuthSettings,
  selfHostAuthOptions,
);

export function hostedDatabaseSchema<S extends Effect.Success<typeof authSettings>, E, R>(
  settingsEffect: Effect.Effect<S, E, R>,
  options: (settings: S, headers: string[]) => BetterAuthOptions,
) {
  return Layer.effect(
    AuthDatabase,
    Effect.gen(function* () {
      const db = yield* makeAuthDatabase;
      const database = AuthDatabase.of({ db, type: "postgres", transaction: true });
      const settings = yield* settingsEffect;
      yield* migrateHostedSchemas({
        ...options(settings, []),
        database,
        secret: Redacted.value(settings.secret),
      });
      return database;
    }),
  );
}
