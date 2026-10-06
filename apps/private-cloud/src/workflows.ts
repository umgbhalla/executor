/** Native workflow body; each product call ends before a timer or checkpoint waits. */
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { Workflow } from "@cloudflare/workers-types";
import { Cause, Effect, Redacted, Result, Schema } from "effect";
import {
  ResolvedAccounts,
  WorkflowRunId,
  WorkflowRpcResult,
  WorkflowStepOptions,
  WorkflowValue,
  HostResponse,
  workflowDurationMillis,
  type WorkflowExecution,
} from "apps/contracts";
import {
  WorkflowBackendState,
  decodeWorkflowFailure,
  workflowFailureDetail,
  workflowFailureMessage,
  type WorkflowRuntime,
} from "@executor-js/sdk/core";
import {
  LoadedWorkerBuild,
  PreparedWorkflow,
  type WorkflowHostCommand,
} from "@executor-js/sdk/workerd";
import { makePrivateAppRunner, type AppEnvironment } from "./apps.ts";

interface WorkflowEnvironment extends AppEnvironment {
  APP_WORKFLOW_HOST: { fetch(request: Request): Promise<Response> };
}
interface NativeStep {
  do(
    name: string,
    options: {
      retries?: { limit: number; delay: number; backoff?: "constant" | "linear" | "exponential" };
      timeout?: number;
    },
    run: () => Promise<typeof WorkflowValue.Type>,
  ): Promise<typeof WorkflowValue.Type>;
  sleep(name: string, duration: number): Promise<void>;
  sleepUntil(name: string, timestamp: number): Promise<void>;
}
const hostRequest = (env: WorkflowEnvironment, command: WorkflowHostCommand) =>
  Effect.tryPromise({
    try: async () => {
      const response = await env.APP_WORKFLOW_HOST.fetch(
        new Request("https://workflow.internal/workflows", {
          method: "POST",
          body: JSON.stringify(command),
        }),
      );
      if (response.status !== 200) throw new Error("Workflow host unavailable");
      return response.json();
    },
    catch: decodeWorkflowFailure,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowRpcResult)),
    Effect.mapError(decodeWorkflowFailure),
    Effect.flatMap((reply) => (reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error))),
  );

export class AppWorkflows extends WorkflowEntrypoint<WorkflowEnvironment, { run: string }> {
  async run(event: Readonly<{ payload: { run: string } }>, nativeStep: unknown) {
    const env = this.env;
    const runner = makePrivateAppRunner(env, this.ctx);
    const step = nativeStep as NativeStep;
    const { NonRetryableError } = await import("cloudflare:workflows");
    const native = <A>(work: () => Promise<A>) =>
      Effect.tryPromise({ try: work, catch: decodeWorkflowFailure });
    const duration = (value: number | string) => {
      const millis = workflowDurationMillis(value);
      if (millis === undefined) throw new NonRetryableError("Invalid workflow duration");
      return millis;
    };
    return Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* Schema.decodeUnknownEffect(WorkflowRunId)(event.payload.run);
        const prepared = yield* hostRequest(env, { operation: "prepare", run }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(PreparedWorkflow)),
        );
        if (prepared.state === "complete") return prepared.output;
        const { seed, accounts } = prepared;
        const execution: WorkflowExecution = {
          runId: seed.runId,
          driver: {
            do: (name, rawOptions, work) =>
              native(async () => {
                const options = Schema.decodeUnknownSync(WorkflowStepOptions)(rawOptions);
                return step.do(
                  name,
                  {
                    ...(options.retries === undefined
                      ? {}
                      : {
                          retries: { ...options.retries, delay: duration(options.retries.delay) },
                        }),
                    ...(options.timeout === undefined
                      ? {}
                      : { timeout: duration(options.timeout) }),
                  },
                  () =>
                    Effect.runPromise(
                      work().pipe(
                        Effect.catch((error) =>
                          Effect.die(
                            error.retryable
                              ? new Error(workflowFailureMessage(error))
                              : new NonRetryableError(workflowFailureMessage(error)),
                          ),
                        ),
                      ),
                    ),
                );
              }),
            sleep: (name, value) => native(() => step.sleep(name, duration(value))),
            sleepUntil: (name, timestamp) => native(() => step.sleepUntil(name, timestamp)),
          },
          resolve: () =>
            hostRequest(env, { operation: "context", run }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ResolvedAccounts)),
              Effect.map((accounts) => ({ accounts: Redacted.make(accounts) })),
              Effect.mapError(decodeWorkflowFailure),
            ),
          invoke: (input) => hostRequest(env, { operation: "invoke", run, ...input }),
        };
        const result = yield* runner
          .invoke(
            {
              app: seed.app,
              build: seed.build,
              database: false,
              accounts,
              command: { operation: "workflow-run", name: seed.name, input: seed.input },
              headers: {},
            },
            {
              load: () =>
                Effect.runPromise(
                  hostRequest(env, { operation: "load", run }).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(LoadedWorkerBuild)),
                  ),
                ),
              elicit: null,
              controls: (input) =>
                Effect.runPromise(
                  hostRequest(env, {
                    operation: "control",
                    run,
                    command: Schema.decodeUnknownSync(Schema.Json)(input),
                  }),
                ),
              workflow: execution,
            },
          )
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(HostResponse)),
            Effect.flatMap((reply) =>
              reply.ok
                ? Schema.decodeUnknownEffect(WorkflowValue)(reply.value).pipe(
                    Effect.mapError(decodeWorkflowFailure),
                  )
                : Effect.fail(decodeWorkflowFailure(reply.error)),
            ),
            Effect.matchCause({
              onSuccess: (output) => ({ ok: true as const, output }),
              onFailure: (cause) => ({
                ok: false as const,
                error: decodeWorkflowFailure(Cause.squash(cause)),
              }),
            }),
          );
        if (!result.ok) {
          if (result.error.reason !== "engine" || !result.error.retryable) {
            const detail = workflowFailureDetail(result.error);
            yield* hostRequest(env, {
              operation: "finish",
              run,
              result: {
                ok: false,
                error: result.error.reason,
                ...(detail === undefined ? {} : { detail }),
              },
            });
          }
          return yield* result.error;
        }
        yield* hostRequest(env, { operation: "finish", run, result });
        return result.output;
      }),
    );
  }
}

export const privateWorkflows = (env: {
  APP_WORKFLOWS: Pick<Workflow<{ run: string }>, "get" | "create">;
}): WorkflowRuntime => {
  const binding = env.APP_WORKFLOWS;
  const status: WorkflowRuntime["status"] = (run) =>
    Effect.tryPromise({
      try: async () => (await binding.get(run)).status(),
      catch: (error) => error,
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(WorkflowBackendState)(
          value.status === "unknown" ? { status: "missing" } : value,
        ),
      ),
      Effect.catch((error) =>
        error instanceof Error && error.message.includes("instance.not_found")
          ? Effect.succeed({ status: "missing" } as const)
          : Effect.fail(decodeWorkflowFailure(error)),
      ),
    );
  return {
    status,
    start: (run) =>
      Effect.gen(function* () {
        if ((yield* status(run)).status !== "missing") return;
        const created = yield* Effect.tryPromise({
          try: async () => {
            await binding.create({ id: run, params: { run } });
          },
          catch: decodeWorkflowFailure,
        }).pipe(Effect.result);
        if (Result.isFailure(created) && (yield* status(run)).status === "missing")
          return yield* created.failure;
      }),
    terminate: (run) =>
      Effect.gen(function* () {
        if (["missing", "complete", "errored", "terminated"].includes((yield* status(run)).status))
          return;
        yield* Effect.tryPromise({
          try: async () => {
            await (await binding.get(run)).terminate();
          },
          catch: decodeWorkflowFailure,
        });
      }),
  };
};
