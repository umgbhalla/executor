/** Private R2 capability; authored apps never receive the bucket binding. */
import type { R2Bucket } from "@cloudflare/workers-types";
import { BlobKey, BlobStoreError, type BlobStorage } from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";

export const r2Blobs = (bucket: R2Bucket): BlobStorage => {
  const key = Schema.decodeUnknownSync(BlobKey);
  return {
    get: (name) =>
      Effect.tryPromise({
        try: async () => {
          const object = await bucket.get(key(name));
          return object === null
            ? Option.none()
            : Option.some(new Uint8Array(await object.arrayBuffer()));
        },
        catch: () => new BlobStoreError({ operation: "get" }),
      }),
    exists: (name) =>
      Effect.tryPromise({
        try: async () => (await bucket.head(key(name))) !== null,
        catch: () => new BlobStoreError({ operation: "exists" }),
      }),
    put: (name, body) =>
      Effect.tryPromise({
        try: async () => {
          await bucket.put(key(name), body);
        },
        catch: () => new BlobStoreError({ operation: "put" }),
      }),
    remove: (name) =>
      Effect.tryPromise({
        try: async () => {
          await bucket.delete(key(name));
        },
        catch: () => new BlobStoreError({ operation: "remove" }),
      }),
  };
};
