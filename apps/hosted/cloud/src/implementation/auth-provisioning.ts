/** Auth setup runs in a scoped Node deployment job, never in a Worker request. */
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { provisionHostedOAuthResources } from "@executor-js/hosted-server";
import { databaseUrl } from "@executor-js/hosted-server/database";
import { HostedMigrationFailed } from "@executor-js/hosted-server/migrations";
import { Config, Effect, Option, Redacted } from "effect";
import { unavailableAuthEmail } from "../contracts/email.ts";
import { cloudAuthOptions, cloudAuthSettings } from "./auth-options.ts";
import { privateOrganizationId, privateOwnerId } from "./single-owner-auth.ts";

/** The caller's scope owns the setup pool; migrations and provisioning use the same options. */
export const cloudAuthSetup = Effect.gen(function* () {
  const url = yield* databaseUrl;
  const settings = yield* cloudAuthSettings;
  const secret = yield* Config.Redacted("BETTER_AUTH_SECRET");
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new Pool({ connectionString: Redacted.value(url), max: 2 }),
      catch: () => new HostedMigrationFailed({ stage: "auth" }),
    }),
    (pool) => Effect.promise(() => pool.end()),
  );
  // Setup serves no requests; the limit stays at its default.
  const base = cloudAuthOptions({ ...settings, rateLimitEnabled: true }, [], unavailableAuthEmail);
  const options = {
    ...base,
    database,
    secret: Redacted.value(secret),
    advanced: { ...base.advanced, database: { validateSchema: false } },
  };
  const provision = Effect.gen(function* () {
    // Run on every deploy, after auth tables exist. Existing sessions and grants
    // must not survive switching a multi-user database into single-owner mode.
    if (Option.isSome(settings.pairingKey)) {
      const result = yield* Effect.tryPromise({
        try: () =>
          database.query<{ invalid: boolean }>(
            `select exists(select 1 from "user" where id <> $1)
            or exists(select 1 from organization where id <> $2)
            or exists(select 1 from member where "userId" <> $1
              or "organizationId" <> $2 or role <> 'owner') as invalid`,
            [privateOwnerId, privateOrganizationId],
          ),
        catch: () => new HostedMigrationFailed({ stage: "auth" }),
      });
      if (result.rows[0]?.invalid !== false)
        return yield* new HostedMigrationFailed({ stage: "auth" });
    }
    const context = yield* Effect.tryPromise({
      try: () => betterAuth(options).$context,
      catch: () => new HostedMigrationFailed({ stage: "auth" }),
    });
    yield* provisionHostedOAuthResources(settings.url, context).pipe(
      Effect.mapError(() => new HostedMigrationFailed({ stage: "auth" })),
    );
  });
  return { url, options, provision };
});
