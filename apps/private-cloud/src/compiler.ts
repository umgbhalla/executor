/** The compiler WASM stays in a separate Worker from the API and app runner. */
import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { SourceFiles, RuntimeBuildFailed } from "@executor-js/sdk/core";
import { compileWorkerApp } from "@executor-js/sdk/workerd/build";
import { CompileResult } from "./apps.ts";

export default class Compiler extends WorkerEntrypoint<Record<string, never>> {
  compile(files: SourceFiles) {
    return Effect.runPromise(
      Schema.decodeUnknownEffect(SourceFiles)(files).pipe(
        Effect.mapError(() => new RuntimeBuildFailed({ stage: "source" })),
        Effect.flatMap((files) => compileWorkerApp(files, {})),
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchTags({
          RuntimeBuildFailed: (error) => Effect.succeed({ ok: false as const, error }),
          RuntimeProtocolUnsupported: (error) => Effect.succeed({ ok: false as const, error }),
          RuntimeAppsDependencyMissing: (error) => Effect.succeed({ ok: false as const, error }),
        }),
        Effect.flatMap(Schema.encodeEffect(CompileResult)),
      ),
    );
  }
  fetch() {
    return new Response(null, { status: 404 });
  }
}
