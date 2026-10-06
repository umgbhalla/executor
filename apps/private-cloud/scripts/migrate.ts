import { Effect } from "effect";
import { migratePrivateDatabase } from "../src/migrate.ts";

await Effect.runPromise(migratePrivateDatabase).catch(() => {
  // Driver errors may contain the connection URL. Keep deploy logs safe.
  console.error("Private database migration failed");
  process.exitCode = 1;
});
