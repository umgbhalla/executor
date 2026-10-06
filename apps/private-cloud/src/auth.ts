import { Effect } from "effect";
import { initializeHostedAuth } from "../../hosted/self-host/src/auth.ts";
import { privateAuthOptions, privateAuthSettings } from "./implementation/auth-options.ts";

export const privateHostedAuth = Effect.gen(function* () {
  const settings = yield* privateAuthSettings;
  return yield* initializeHostedAuth(settings, privateAuthOptions(settings, ["cf-connecting-ip"]));
});
