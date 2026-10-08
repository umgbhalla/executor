/** Single-owner admission through the real Cloud Worker and WebAuthn ceremonies. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target, driver } from "../support/platform.ts";

layer(TestLive, { excludeTestServices: true })("Single owner", (it) => {
  it.effect("single owner pairing admits multiple verified passkeys", (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;
        // Only the isolated --single-owner environment accepts this synthetic key.
        const key = "synthetic-single-owner-pairing-key-for-e2e";
        const origin = target.metadata.origin;
        const request = (label: string, path: string, data?: unknown) =>
          browser.use(label, (page) =>
            page
              .context()
              .request.fetch(`/api/auth${path}`, {
                method: data === undefined ? "GET" : "POST",
                headers: { origin },
                ...(data === undefined ? {} : { data }),
              })
              .then((response) =>
                response.text().then((body) => ({
                  status: response.status(),
                  body: body ? JSON.parse(body) : null,
                })),
              ),
          );
        yield* browser.omitNetworkTrace;
        yield* browser.use("Open owner login", (page) => page.goto("/login"));
        expect(
          (yield* request("Read single-owner policy", "/single-owner/config")).body.enabled,
        ).toBe(true);
        expect(
          (yield* request("Reject wrong pairing key", "/single-owner/pair", {
            key: "invalid-key-that-cannot-pair-this-browser",
          })).status,
        ).toBe(403);
        const deniedAdmissions = [
          {
            path: "/sign-up/email",
            body: {
              name: "Another owner",
              email: "another@example.com",
              password: "synthetic-password-for-e2e",
            },
          },
          {
            path: "/sign-in/email",
            body: { email: "another@example.com", password: "synthetic-password-for-e2e" },
          },
          { path: "/sign-in/social", body: { provider: "google", callbackURL: `${origin}/` } },
          {
            path: "/organization/create",
            body: { name: "Second organization", slug: "second-organization" },
          },
          {
            path: "/organization/invite-member",
            body: {
              email: "another@example.com",
              role: "member",
              organizationId: "private-executor",
            },
          },
        ];
        for (const admission of deniedAdmissions) {
          expect(
            (yield* request("Reject additional account admission", admission.path, admission.body))
              .status,
          ).toBe(403);
        }
        expect(
          (yield* request(
            "Email-code provider is not installed",
            "/email-otp/send-verification-otp",
            { email: "another@example.com", type: "sign-in" },
          )).status,
        ).toBe(404);
        expect(
          (yield* request("Reject unpaired enrollment", "/passkey/generate-register-options"))
            .status,
        ).toBe(403);
        const pairs = yield* Effect.all(
          [
            request("First concurrent owner pairing", "/single-owner/pair", { key }),
            request("Second concurrent owner pairing", "/single-owner/pair", { key }),
          ],
          { concurrency: 2 },
        );
        expect(pairs.map((response) => response.status)).toEqual([200, 200]);
        const enrollment = yield* browser.use("Read enrollment-only cookie", (page) =>
          page
            .context()
            .cookies()
            .then((cookies) =>
              cookies.find((cookie) => cookie.name === "executor-private-enrollment"),
            ),
        );
        expect(enrollment?.httpOnly).toBe(true);
        expect(enrollment?.sameSite).toBe("Strict");
        expect(enrollment!.expires - Date.now() / 1000).toBeGreaterThan(0);
        expect(enrollment!.expires - Date.now() / 1000).toBeLessThanOrEqual(300);
        expect((yield* request("Pairing grants no login session", "/get-session")).body).toBeNull();
        const session = yield* browser.use("Enable real WebAuthn ceremonies", (page) =>
          page.context().newCDPSession(page),
        );
        yield* driver("Enable WebAuthn", () => session.send("WebAuthn.enable"));
        yield* Effect.addFinalizer(() =>
          driver("Release authenticator", () => session.detach()).pipe(Effect.orDie),
        );
        const addAuthenticator = () =>
          driver("Add a verified hardware key", () =>
            session.send("WebAuthn.addVirtualAuthenticator", {
              options: {
                protocol: "ctap2",
                transport: "usb",
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
              },
            }),
          );
        const pairAndRegister = Effect.gen(function* () {
          yield* browser.use("Show pairing form", (page) =>
            page.getByRole("button", { name: "Pair this browser", exact: true }).click(),
          );
          yield* browser.use("Paste synthetic pairing key", (page) =>
            page.getByLabel("Pairing key", { exact: true }).fill(key),
          );
          yield* browser.use("Pair browser", (page) =>
            page.getByRole("button", { name: "Pair this browser", exact: true }).click(),
          );
          yield* browser.use("Register verified passkey", (page) =>
            page.getByRole("button", { name: "Register passkey", exact: true }).click(),
          );
          yield* browser.use("Enrollment completes without login", (page) =>
            page.getByText("Passkey added. Sign in to continue.", { exact: true }).waitFor(),
          );
          expect(
            (yield* request("Enrollment grants no login session", "/get-session")).body,
          ).toBeNull();
        });
        const first = yield* addAuthenticator();
        yield* pairAndRegister;
        yield* driver("Remove first hardware key", () =>
          session.send("WebAuthn.removeVirtualAuthenticator", {
            authenticatorId: first.authenticatorId,
          }),
        );
        yield* addAuthenticator();
        yield* pairAndRegister;
        expect(
          (yield* request(
            "Require verified authentication",
            "/passkey/generate-authenticate-options",
          )).body.userVerification,
        ).toBe("required");
        yield* browser.use("Sign in using second passkey", (page) =>
          page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click(),
        );
        yield* browser.use("Enter owner dashboard", (page) =>
          page.waitForURL((url) => url.pathname !== "/login"),
        );
        const current = (yield* request("Read sole owner session", "/get-session")).body;
        expect(current.user.id).toBe("private-owner");
        expect(current.session.activeOrganizationId).toBe("private-executor");
        yield* browser.use("Drop expired pairing authority after owner login", (page) =>
          page.context().clearCookies({ name: "executor-private-enrollment" }),
        );
        expect(
          (yield* request(
            "Verified owner can enroll without pairing cookie",
            "/passkey/generate-register-options",
          )).status,
        ).toBe(200);
        const passkeys = (yield* request(
          "Both hardware keys belong to owner",
          "/passkey/list-user-passkeys",
        )).body;
        expect(passkeys).toHaveLength(2);
        expect(
          passkeys.every((passkey: { userId: string }) => passkey.userId === "private-owner"),
        ).toBe(true);
        const organizations = (yield* request("Only one organization exists", "/organization/list"))
          .body;
        expect(organizations.map((organization: { id: string }) => organization.id)).toEqual([
          "private-executor",
        ]);
        expect(
          (yield* request("Owner cannot add another organization", "/organization/create", {
            name: "Second",
            slug: "second",
          })).status,
        ).toBe(403);
        expect(
          (yield* request("Owner cannot invite another user", "/organization/invite-member", {
            email: "other@example.invalid",
            role: "member",
          })).status,
        ).toBe(403);
        const removal = yield* browser.use("Owner cannot remove the fixed organization", (page) =>
          page
            .context()
            .request.delete("/api/organizations/private-executor", { headers: { origin } })
            .then((response) => response.status()),
        );
        expect(removal).toBe(403);
        const retained = yield* request(
          "Fixed organization and owner membership remain accessible",
          "/organization/get-full-organization?organizationId=private-executor",
        );
        expect(retained.status).toBe(200);
        expect(retained.body.id).toBe("private-executor");
        expect(retained.body.members).toHaveLength(1);
        expect(retained.body.members[0].userId).toBe("private-owner");
        expect(retained.body.members[0].role).toBe("owner");
        yield* browser.checkpoint("Two hardware keys access the same locked owner account");
      }),
    ),
  );
});
