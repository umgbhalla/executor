/** Git storage uses a private Artifacts namespace and encrypted repository credentials. */
import type { Artifacts, DurableObjectStorage } from "@cloudflare/workers-types";
import { cloudflareRepositories, type ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import { AppCodeId, SourceError, aesGcmCredentials } from "@executor-js/sdk/core";
import { Clock, Effect, Redacted, Schema, Semaphore } from "effect";

const Credential = Schema.Struct({
  token: Schema.NonEmptyString,
  generation: Schema.NonEmptyString,
  expiresAt: Schema.Number.check(Schema.isFinite()),
});
const dispose = (value: unknown) => {
  if (value !== null && typeof value === "object" && Symbol.dispose in value) {
    const release = value[Symbol.dispose];
    if (typeof release === "function") release.call(value);
  }
};
const failure = () => new SourceError({ reason: "git" });

export const privateRepositories = (options: {
  readonly binding: Artifacts;
  readonly storage: DurableObjectStorage;
  readonly accountId: string;
  readonly namespace: string;
  readonly encryptionKey: Redacted.Redacted<string>;
}) =>
  Effect.gen(function* () {
    const encryption = yield* aesGcmCredentials(options.encryptionKey, crypto);
    const lock = yield* Semaphore.make(1);
    const key = (repository: AppCodeId) => `executor.artifacts.${repository}`;
    const save = (repository: AppCodeId, credential: typeof Credential.Type) =>
      Effect.gen(function* () {
        const encrypted = yield* encryption.encrypt(repository, Redacted.make({ ...credential }));
        yield* Effect.tryPromise({
          try: async () => {
            await options.storage.put(key(repository), encrypted);
            await options.storage.sync();
          },
          catch: failure,
        });
      });
    const tokens: ArtifactsTokens = {
      create: (repository) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* Schema.decodeUnknownEffect(AppCodeId)(repository);
            const created = yield* Effect.tryPromise({
              try: () => options.binding.create(repository, { setDefaultBranch: "main" }),
              catch: (error) =>
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ALREADY_EXISTS"
                  ? null
                  : failure(),
            }).pipe(
              Effect.catch((error) => (error === null ? Effect.succeed(null) : Effect.fail(error))),
            );
            if (created === null) return null;
            try {
              const credential = yield* Effect.tryPromise({
                try: async () => ({
                  token: await created.token,
                  generation: crypto.randomUUID(),
                  expiresAt: Date.parse(await created.tokenExpiresAt),
                }),
                catch: failure,
              }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Credential)));
              yield* save(repository, credential);
              return Redacted.make(credential.token);
            } finally {
              dispose(created);
            }
          }).pipe(Effect.mapError(failure)),
        ),
      acquire: (repository, rejected) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* Schema.decodeUnknownEffect(AppCodeId)(repository);
            const now = yield* Clock.currentTimeMillis;
            const saved = yield* Effect.tryPromise({
              try: () => options.storage.get<Uint8Array>(key(repository)),
              catch: failure,
            });
            if (saved !== undefined) {
              const decoded = yield* encryption.decrypt(repository, Redacted.make(saved));
              const credential = yield* Schema.decodeUnknownEffect(Credential)(
                Redacted.value(decoded),
              );
              if (credential.generation !== rejected && credential.expiresAt > now + 300_000)
                return {
                  token: Redacted.make(credential.token),
                  generation: credential.generation,
                };
            }
            const repositoryHandle = yield* Effect.tryPromise({
              try: () => options.binding.get(repository),
              catch: failure,
            });
            try {
              const issued = yield* Effect.tryPromise({
                try: () => repositoryHandle.createToken("write", 31_536_000),
                catch: failure,
              });
              try {
                const credential = yield* Effect.tryPromise({
                  try: async () => ({
                    token: await issued.plaintext,
                    generation: await issued.id,
                    expiresAt: Date.parse(await issued.expiresAt),
                  }),
                  catch: failure,
                }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Credential)));
                if (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= now + 300_000)
                  return yield* failure();
                yield* save(repository, credential);
                return {
                  token: Redacted.make(credential.token),
                  generation: credential.generation,
                };
              } finally {
                dispose(issued);
              }
            } finally {
              dispose(repositoryHandle);
            }
          }).pipe(Effect.mapError(failure)),
        ),
    };
    return cloudflareRepositories(tokens, {
      accountId: options.accountId,
      namespace: options.namespace,
    });
  });
