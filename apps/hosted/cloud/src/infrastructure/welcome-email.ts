import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Option } from "effect";
import { singleOwnerPairingKey } from "../implementation/single-owner-auth.ts";
import { HttpServerResponse } from "effect/http";
import { cloudDatabaseConnection } from "./database.ts";
import { deliverWelcomeEmails } from "../implementation/welcome-emails.ts";
import type { SendWelcomeEmail } from "../contracts/email.ts";
import { cloudOrigin } from "./stage.ts";
import { cloudSecrets } from "./secrets.ts";
import { unsubscribeHandler, unsubscribeLinks } from "../implementation/email-preferences.ts";

/** The cron invocation owns its database connection and closes it after the batch. */
export const cloudWelcomeEmails = (send: SendWelcomeEmail) =>
  Effect.gen(function* () {
    const privateMode = Option.isSome(yield* singleOwnerPairingKey.pipe(Effect.orDie));
    const connection = yield* cloudDatabaseConnection;
    const origin = yield* cloudOrigin.pipe(Effect.orDie);
    const secrets = yield* cloudSecrets.pipe(Effect.orDie);
    const database = Layer.unwrap(
      connection.connectionString.pipe(
        Effect.map((url) => PgClient.layer({ url, maxConnections: 1, prepare: false })),
      ),
    );
    const deliverUser = (user?: string) =>
      privateMode
        ? Effect.void
        : Effect.scoped(
            deliverWelcomeEmails(
              send,
              (id, email) =>
                secrets.authSecret.pipe(
                  Effect.flatMap((secret) => unsubscribeLinks(origin, secret, id, email)),
                ),
              origin,
              user,
            ).pipe(Effect.provide(database)),
          );
    return {
      deliver: deliverUser().pipe(
        Effect.catch(() => Effect.logError("Welcome email queue processing failed")),
      ),
      deliverUser,
      unsubscribe: unsubscribeHandler(origin, secrets.authSecret).pipe(
        Effect.provide(database),
        Effect.scoped,
        Effect.catchTag("SqlError", () =>
          Effect.succeed(
            HttpServerResponse.empty({
              status: 503,
              headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
            }),
          ),
        ),
      ),
    };
  });
