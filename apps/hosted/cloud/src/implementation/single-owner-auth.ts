import { timingSafeEqual } from "node:crypto";
import { authOptions } from "@executor-js/hosted-server";
import { passkey } from "@better-auth/passkey";
import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { Config, Effect, Option, Redacted, Schema } from "effect";

export const privateOwnerId = "private-owner";
export const privateOrganizationId = "private-executor";
const enrollmentCookie = "executor-private-enrollment";
const enrollmentSeconds = 300;
class InvalidPairingKey extends Schema.TaggedError<InvalidPairingKey>()("InvalidPairingKey", {}) {}

export const singleOwnerPairingKey = Config.Redacted("EXECUTOR_PAIRING_KEY").pipe(
  Config.option,
  Effect.flatMap((key) =>
    Option.isSome(key) && Redacted.value(key.value).length < 32
      ? Effect.fail(new InvalidPairingKey())
      : Effect.succeed(key),
  ),
);
type Settings = Parameters<typeof authOptions>[0] & {
  readonly pairingKey: Redacted.Redacted<string>;
  readonly rateLimitEnabled: boolean;
};

export const singleOwnerConfiguration = (enabled: boolean) =>
  ({
    id: "executor-single-owner-configuration",
    endpoints: {
      singleOwnerConfiguration: createAuthEndpoint(
        "/single-owner/config",
        { method: "GET" },
        (ctx) => ctx.json({ enabled }),
      ),
    },
  }) satisfies BetterAuthPlugin;

const deny = () => {
  throw new APIError("FORBIDDEN");
};
const enrollment = async (ctx: GenericEndpointContext) => {
  if (ctx.headers?.has("authorization")) return deny();
  const session = await getSessionFromCtx(ctx);
  if (session?.user.id === privateOwnerId && session.user.emailVerified)
    return { id: privateOwnerId, name: "Owner", displayName: "Owner" };
  const token = await ctx.getSignedCookie(enrollmentCookie, ctx.context.secret);
  if (!token) return deny();
  const value = await ctx.context.internalAdapter.findVerificationValue(
    `private-enrollment:${token}`,
  );
  if (!value || value.expiresAt.getTime() <= Date.now() || value.value !== privateOwnerId)
    return deny();
  return { id: privateOwnerId, name: "Owner", displayName: "Owner" };
};

/** Hash both values before a fixed-length comparison; never expose the operator key. */
const matchesKey = async (expected: string, supplied: string) => {
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([digest(expected), digest(supplied)]);
  return timingSafeEqual(left, right);
};

const pairing = (settings: Settings) =>
  ({
    id: "executor-private-pairing",
    endpoints: {
      pairPrivateOwner: createAuthEndpoint(
        "/single-owner/pair",
        {
          method: "POST",
          body: Schema.toStandardSchemaV1(
            Schema.Struct({
              key: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
            }),
          ),
        },
        async (ctx) => {
          if (ctx.headers?.has("authorization") || ctx.headers?.get("origin") !== settings.url)
            return deny();
          if (!(await matchesKey(Redacted.value(settings.pairingKey), ctx.body.key))) return deny();
          const provision = () =>
            runWithTransaction(ctx.context.adapter, async () => {
              const adapter = await getCurrentAdapter(ctx.context.adapter);
              const users = await adapter.findMany<{ id: string }>({ model: "user", limit: 2 });
              const orgs = await adapter.findMany<{ id: string }>({
                model: "organization",
                limit: 2,
              });
              if (
                users.some((user) => user.id !== privateOwnerId) ||
                orgs.some((org) => org.id !== privateOrganizationId)
              )
                return deny();
              if (users.length === 0)
                await adapter.create({
                  model: "user",
                  forceAllowId: true,
                  data: {
                    id: privateOwnerId,
                    name: "Owner",
                    email: "owner@executor.invalid",
                    emailVerified: true,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                });
              if (orgs.length === 0)
                await adapter.create({
                  model: "organization",
                  forceAllowId: true,
                  data: {
                    id: privateOrganizationId,
                    name: "Private Executor",
                    slug: "executor",
                    createdAt: new Date(),
                  },
                });
              const member = await adapter.findOne({
                model: "member",
                where: [{ field: "userId", value: privateOwnerId }],
              });
              if (!member)
                await adapter.create({
                  model: "member",
                  data: {
                    userId: privateOwnerId,
                    organizationId: privateOrganizationId,
                    role: "owner",
                    createdAt: new Date(),
                  },
                });
            });
          // Concurrent first pairings race on the fixed primary keys. Retry the complete
          // transaction once after the winner commits; no partial account survives rollback.
          try {
            await provision();
          } catch (error) {
            if (error instanceof APIError) throw error;
            await provision();
          }
          const token = crypto.randomUUID();
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `private-enrollment:${token}`,
            value: privateOwnerId,
            expiresAt: new Date(Date.now() + enrollmentSeconds * 1000),
          });
          await ctx.setSignedCookie(enrollmentCookie, token, ctx.context.secret, {
            httpOnly: true,
            secure: new URL(settings.url).protocol === "https:",
            sameSite: "strict",
            path: "/api/auth",
            maxAge: enrollmentSeconds,
          });
          return ctx.json({ paired: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;

export const singleOwnerAuthOptions = (settings: Settings, ipAddressHeaders: string[]) => {
  const base = authOptions(settings, ipAddressHeaders);
  return {
    ...base,
    databaseHooks: {
      user: { create: { before: async () => deny() } },
      session: {
        create: {
          before: async (session: { userId: string }, ctx: GenericEndpointContext | null) => {
            if (session.userId !== privateOwnerId || ctx?.path !== "/passkey/verify-authentication")
              return deny();
            return { data: { ...session, activeOrganizationId: privateOrganizationId } };
          },
        },
      },
    },
    plugins: [
      ...base.plugins.filter((plugin) => plugin.id !== "admin"),
      organization({ disableOrganizationDeletion: true, allowUserToCreateOrganization: false }),
      singleOwnerConfiguration(true),
      pairing(settings),
      passkey({
        rpID: new URL(settings.url).hostname,
        rpName: "Private Executor",
        origin: settings.url,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: {
          requireSession: false,
          resolveUser: ({ ctx }) => enrollment(ctx),
          afterVerification: async ({ ctx, verification, user }) => {
            await enrollment(ctx);
            if (user.id !== privateOwnerId || !verification.registrationInfo?.userVerified)
              return deny();
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) return deny();
          },
        },
      }),
    ],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (
          ctx.path === "/passkey/generate-authenticate-options" &&
          returned &&
          typeof returned === "object" &&
          "challenge" in returned
        )
          Object.assign(returned, { userVerification: "required" });
      }),
      before: createAuthMiddleware(async (ctx) => {
        const path = ctx.path ?? "";
        if (path.startsWith("/passkey/") && ctx.headers?.has("authorization")) return deny();
        if (
          path.startsWith("/admin/") ||
          path.startsWith("/sign-up/") ||
          path.startsWith("/sign-in/") ||
          path.startsWith("/callback/") ||
          path.startsWith("/sso/") ||
          path.startsWith("/email-otp/") ||
          path.startsWith("/forget-password") ||
          path.startsWith("/reset-password") ||
          path.startsWith("/change-password") ||
          path.startsWith("/set-password") ||
          path.startsWith("/link-social") ||
          path.startsWith("/unlink-account") ||
          path.startsWith("/delete-user") ||
          (path.startsWith("/self-host/") && path !== "/self-host/config") ||
          path.startsWith("/update-user") ||
          path.startsWith("/change-email")
        )
          return deny();
        if (
          path.startsWith("/organization/") &&
          ![
            "/organization/list",
            "/organization/get-full-organization",
            "/organization/set-active",
            "/organization/list-members",
            "/organization/get-active-member",
            "/organization/get-active-member-role",
          ].includes(path)
        )
          return deny();
        if (path === "/passkey/verify-registration") ctx.body.createSession = false;
        if (
          path.startsWith("/passkey/") &&
          !["/passkey/generate-authenticate-options", "/passkey/verify-authentication"].includes(
            path,
          ) &&
          ctx.method !== "GET" &&
          ctx.headers?.get("origin") !== settings.url
        )
          return deny();
        if (path === "/api-key/create") {
          ctx.body.metadata = { ...ctx.body.metadata, organization: privateOrganizationId };
        }
        await base.hooks.before(ctx as Parameters<typeof base.hooks.before>[0]);
      }),
    },
    rateLimit: {
      ...base.rateLimit,
      enabled: settings.rateLimitEnabled,
      customRules: { ...base.rateLimit.customRules, "/single-owner/pair": { window: 60, max: 5 } },
    },
  };
};
