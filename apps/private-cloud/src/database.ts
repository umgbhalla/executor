import { hostedDatabaseSchema } from "../../hosted/self-host/src/implementation/database-schema.ts";
import { privateAuthOptions, privateAuthSettings } from "./implementation/auth-options.ts";

export const privateHostedDatabaseSchema = hostedDatabaseSchema(
  privateAuthSettings,
  privateAuthOptions,
);
