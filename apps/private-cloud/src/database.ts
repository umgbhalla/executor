import { hostedDatabaseSchema } from "@executor-js/hosted-self-host/database";
import { privateAuthOptions, privateAuthSettings } from "./implementation/auth-options.ts";

export const privateHostedDatabaseSchema = hostedDatabaseSchema(
  privateAuthSettings,
  privateAuthOptions,
);
