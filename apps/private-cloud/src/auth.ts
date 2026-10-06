import { Effect } from "effect";
import { initializeHostedAuth } from "@executor-js/hosted-self-host/auth";
import { privateAuthOptions, privateAuthSettings } from "./implementation/auth-options.ts";

export const privateHostedAuth = Effect.gen(function* () {
  const settings = yield* privateAuthSettings;
  return yield* initializeHostedAuth(settings, privateAuthOptions(settings, ["cf-connecting-ip"]));
});
