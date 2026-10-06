/** Native checkpoints and timers; the private executor retains app and account authority. */
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { Workflow } from "@cloudflare/workers-types";
import { Effect, Result, Schema } from "effect";
import {
  type WorkflowFailure,
  WorkflowRunId,
  WorkflowRpcResult,
  WorkflowStepOptions,
  WorkflowValue,
  workflowDurationMillis,
} from "apps/contracts";
import {
  WorkflowBackendState,
  decodeWorkflowFailure,
  workflowFailureMessage,
  type WorkflowDriver,
  type WorkflowRuntime,
} from "@executor-js/sdk/core";

export interface WorkflowSteps {
  do(
    name: string,
    options: WorkflowStepOptions,
    run: () => Promise<typeof WorkflowRpcResult.Encoded>,
  ): Promise<typeof WorkflowRpcResult.Encoded>;
  sleep(name: string, duration: number | string): Promise<typeof WorkflowRpcResult.Encoded>;
  sleepUntil(name: string, timestamp: number): Promise<typeof WorkflowRpcResult.Encoded>;
}

export const workflowReply = <A>(effect: Effect.Effect<A, WorkflowFailure>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (error) => ({ ok: false as const, error }),
      }),
      Effect.flatMap(Schema.encodeUnknownEffect(WorkflowRpcResult)),
    ),
  );

const settle = (work: () => Promise<typeof WorkflowRpcResult.Encoded>) =>
  Effect.tryPromise({ try: work, catch: decodeWorkflowFailure }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowRpcResult)),
    Effect.mapError(decodeWorkflowFailure),
    Effect.flatMap((reply) => (reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error))),
  );

export const workflowDriver = (steps: WorkflowSteps): WorkflowDriver => ({
  do: (name, options, run) => settle(() => steps.do(name, options, () => workflowReply(run()))),
  sleep: (name, duration) => settle(() => steps.sleep(name, duration)).pipe(Effect.asVoid),
  sleepUntil: (name, timestamp) =>
    settle(() => steps.sleepUntil(name, timestamp)).pipe(Effect.asVoid),
});

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

export class PrivateWorkflows extends WorkflowEntrypoint<
  {
    APP_WORKFLOW_HOST: {
      executeWorkflow(run: string, steps: WorkflowSteps): Promise<typeof WorkflowRpcResult.Encoded>;
    };
  },
  { run: string }
> {
  async run(event: Readonly<{ payload: { run: string } }>, nativeStep: unknown) {
    const run = Schema.decodeUnknownSync(WorkflowRunId)(event.payload.run);
    const step = nativeStep as NativeStep;
    const { NonRetryableError } = await import("cloudflare:workflows");
    const reply = <A>(work: () => Promise<A>) =>
      workflowReply(Effect.tryPromise({ try: work, catch: decodeWorkflowFailure }));
    const duration = (value: number | string) => {
      const millis = workflowDurationMillis(value);
      if (millis === undefined) throw new NonRetryableError("Invalid workflow duration");
      return millis;
    };
    const steps: WorkflowSteps = {
      do: (name, rawOptions, work) =>
        reply(async () => {
          const options = Schema.decodeUnknownSync(WorkflowStepOptions)(rawOptions);
          return step.do(
            name,
            {
              ...(options.retries === undefined
                ? {}
                : { retries: { ...options.retries, delay: duration(options.retries.delay) } }),
              ...(options.timeout === undefined ? {} : { timeout: duration(options.timeout) }),
            },
            async () => {
              const result = Schema.decodeUnknownSync(WorkflowRpcResult)(await work());
              if (result.ok) return result.value;
              const message = workflowFailureMessage(result.error);
              throw result.error.retryable ? new Error(message) : new NonRetryableError(message);
            },
          );
        }),
      sleep: (name, value) =>
        reply(async () => {
          await step.sleep(name, duration(value));
          return null;
        }),
      sleepUntil: (name, timestamp) =>
        reply(async () => {
          await step.sleepUntil(name, timestamp);
          return null;
        }),
    };
    return Effect.runPromise(settle(() => this.env.APP_WORKFLOW_HOST.executeWorkflow(run, steps)));
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
