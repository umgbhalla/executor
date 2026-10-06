import { authOptions, authSettings } from "@executor-js/hosted-server";
import { passkey } from "@better-auth/passkey";
import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { Config, Effect, Redacted } from "effect";
import { z } from "zod";

export const privateOwnerId = "private-owner";
export const privateOrganizationId = "private-executor";
const enrollmentCookie = "executor-private-enrollment";
const enrollmentSeconds = 300;

export const privateAuthSettings = Effect.gen(function* () {
  const base = yield* authSettings;
  const pairingKey = yield* Config.Redacted("EXECUTOR_PAIRING_KEY");
  if (Redacted.value(pairingKey).length < 32)
    return yield* Effect.fail(new Error("EXECUTOR_PAIRING_KEY needs at least 32 characters"));
  return { ...base, pairingKey };
});

const deny = () => {
  throw new APIError("FORBIDDEN");
};
const enrollment = async (ctx: GenericEndpointContext) => {
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
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
};

const pairing = (settings: Effect.Success<typeof privateAuthSettings>) =>
  ({
    id: "executor-private-pairing",
    endpoints: {
      getPrivateConfiguration: createAuthEndpoint("/self-host/config", { method: "GET" }, (ctx) =>
        ctx.json({ setup: false, sso: false, private: true }),
      ),
      pairPrivateOwner: createAuthEndpoint(
        "/private/pair",
        {
          method: "POST",
          body: z.object({ key: z.string().min(32).max(512) }),
        },
        async (ctx) => {
          if (ctx.headers?.has("authorization") || ctx.headers?.get("origin") !== settings.url)
            return deny();
          if (!(await matchesKey(Redacted.value(settings.pairingKey), ctx.body.key))) return deny();
          await runWithTransaction(ctx.context.adapter, async () => {
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

export const privateAuthOptions = (
  settings: Effect.Success<typeof privateAuthSettings>,
  ipAddressHeaders: string[],
) => {
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
      ...base.plugins.filter((plugin) => plugin.id !== "organization" && plugin.id !== "admin"),
      organization({ disableOrganizationDeletion: true, allowUserToCreateOrganization: false }),
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
          const body = ctx.body;
          if (
            !Number.isInteger(body?.expiresIn) ||
            body.expiresIn <= 0 ||
            body.metadata?.organization !== privateOrganizationId
          )
            return deny();
        }
        await base.hooks.before(ctx as Parameters<typeof base.hooks.before>[0]);
      }),
    },
    rateLimit: {
      ...base.rateLimit,
      customRules: { ...base.rateLimit.customRules, "/private/pair": { window: 60, max: 5 } },
    },
  };
};
