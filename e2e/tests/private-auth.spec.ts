/** Paired enrollment and agent keys use the real private Worker and browser ceremonies. */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, Redacted, Schedule } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target, driver } from "../support/platform.ts";

layer(TestLive, { excludeTestServices: true })("Private owner authentication", (it) => {
  it.effect(
    "private owner pairing admits multiple verified passkeys and expiring pinned agent keys",
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const browser = yield* Browser;
          const target = yield* Target;
          const pairingKey = yield* Config.Redacted("EXECUTOR_PRIVATE_E2E_PAIRING_KEY");
          const origin = target.metadata.origin;
          const request = (
            label: string,
            path: string,
            method = "GET",
            data?: unknown,
            headers: Record<string, string> = {},
          ) =>
            browser.use(label, (page) =>
              page
                .context()
                .request.fetch(path, {
                  method,
                  ...(data === undefined ? {} : { data }),
                  headers: { origin, ...headers },
                })
                .then((response) =>
                  response.text().then((text) => ({
                    status: response.status(),
                    body: text ? JSON.parse(text) : null,
                  })),
                ),
            );
          yield* browser.omitNetworkTrace;
          yield* browser.use("Open the private login page", (page) => page.goto("/login"));
          const session = yield* browser.use("Enable virtual hardware for real WebAuthn", (page) =>
            page.context().newCDPSession(page),
          );
          yield* driver("Enable WebAuthn", () => session.send("WebAuthn.enable"));
          const authenticator = yield* driver("Add the owner's virtual authenticator", () =>
            session.send("WebAuthn.addVirtualAuthenticator", {
              options: {
                protocol: "ctap2",
                transport: "internal",
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
              },
            }),
          );
          yield* Effect.addFinalizer(() =>
            driver("Release virtual authenticator", () => session.detach()).pipe(Effect.orDie),
          );
          expect(
            (yield* request("Reject wrong pairing key", "/api/auth/private/pair", "POST", {
              key: "wrong-pairing-key-that-is-long-enough",
            })).status,
          ).toBe(403);
          for (const path of [
            "/sign-up/email",
            "/sign-in/email",
            "/sign-in/social",
            "/self-host/setup",
            "/self-host/register",
            "/organization/create",
            "/organization/invite-member",
          ]) {
            expect(
              (yield* request("Reject extra account admission", `/api/auth${path}`, "POST", {}))
                .status,
            ).toBe(403);
          }
          expect(
            (yield* request(
              "Unpaired browser cannot enroll",
              "/api/auth/passkey/generate-register-options",
            )).status,
          ).toBe(403);
          expect(
            (yield* request(
              "Bearer credentials cannot pair",
              "/api/auth/private/pair",
              "POST",
              { key: Redacted.value(pairingKey) },
              { authorization: "Bearer exp_untrusted" },
            )).status,
          ).toBe(403);
          expect(
            (yield* request("Pair owner without login", "/api/auth/private/pair", "POST", {
              key: Redacted.value(pairingKey),
            })).status,
          ).toBe(200);
          const cookie = yield* browser.use("Inspect short HttpOnly enrollment cookie", (page) =>
            page
              .context()
              .cookies()
              .then((cookies) =>
                cookies.find((value) => value.name === "executor-private-enrollment"),
              ),
          );
          expect(cookie?.httpOnly).toBe(true);
          expect(cookie?.sameSite).toBe("Strict");
          expect(cookie!.expires - Date.now() / 1000).toBeGreaterThan(0);
          expect(cookie!.expires - Date.now() / 1000).toBeLessThanOrEqual(300);
          expect(
            (yield* request("Pairing does not create a session", "/api/auth/get-session")).body,
          ).toBeNull();
          const pair = Effect.gen(function* () {
            yield* browser.use("Paste manual pairing key", (page) =>
              page.getByLabel("Pairing key", { exact: true }).fill(Redacted.value(pairingKey)),
            );
            yield* browser.use("Pair to the existing owner", (page) =>
              page
                .getByRole("button", { name: "Pair a passkey or hardware key", exact: true })
                .click(),
            );
            yield* browser.use("Enrollment becomes available", (page) =>
              page
                .getByRole("button", { name: "Add a passkey or hardware key", exact: true })
                .waitFor(),
            );
            yield* browser.use("Enroll a verified key", (page) =>
              page
                .getByRole("button", { name: "Add a passkey or hardware key", exact: true })
                .click(),
            );
            yield* browser.use("Enrollment completes", (page) =>
              page
                .getByRole("button", { name: "Pair a passkey or hardware key", exact: true })
                .waitFor(),
            );
          });
          yield* browser.use("Paste the manual key for the rejected ceremony", (page) =>
            page.getByLabel("Pairing key", { exact: true }).fill(Redacted.value(pairingKey)),
          );
          yield* browser.use("Open paired enrollment", (page) =>
            page
              .getByRole("button", { name: "Pair a passkey or hardware key", exact: true })
              .click(),
          );
          yield* browser.use("Ask the browser for an unverified ceremony", (page) =>
            page.route("**/api/auth/passkey/generate-register-options*", (route) =>
              route.fetch().then((response) =>
                response.json().then((body) =>
                  route.fulfill({
                    response,
                    json: {
                      ...body,
                      authenticatorSelection: {
                        ...body.authenticatorSelection,
                        userVerification: "preferred",
                      },
                    },
                  }),
                ),
              ),
            ),
          );
          yield* driver("Disable authenticator user verification", () =>
            session.send("WebAuthn.setUserVerified", {
              authenticatorId: authenticator.authenticatorId,
              isUserVerified: false,
            }),
          );
          const rejected = yield* browser.use(
            "Server rejects the signed unverified ceremony",
            (page) =>
              Promise.all([
                page.waitForResponse(
                  (response) =>
                    new URL(response.url()).pathname === "/api/auth/passkey/verify-registration",
                ),
                page
                  .getByRole("button", { name: "Add a passkey or hardware key", exact: true })
                  .click(),
              ]).then(([response]) => response.status()),
          );
          expect(rejected).toBe(403);
          yield* browser.use("The failed ceremony remains available for retry", (page) =>
            page.getByRole("alert").waitFor(),
          );
          const rejectedCredentials = yield* driver("Read the rejected hardware credential", () =>
            session.send("WebAuthn.getCredentials", {
              authenticatorId: authenticator.authenticatorId,
            }),
          );
          yield* Effect.forEach(rejectedCredentials.credentials, (credential) =>
            driver("Remove the unregistered hardware credential", () =>
              session.send("WebAuthn.removeCredential", {
                authenticatorId: authenticator.authenticatorId,
                credentialId: credential.credentialId,
              }),
            ),
          );
          yield* browser.use("Restore real registration options", (page) =>
            page.unroute("**/api/auth/passkey/generate-register-options*"),
          );
          yield* driver("Restore authenticator user verification", () =>
            session.send("WebAuthn.setUserVerified", {
              authenticatorId: authenticator.authenticatorId,
              isUserVerified: true,
            }),
          );
          yield* browser.use("Enroll the verified passkey", (page) =>
            page
              .getByRole("button", { name: "Add a passkey or hardware key", exact: true })
              .click(),
          );
          yield* browser.use("Verified enrollment completes", (page) =>
            page
              .getByRole("button", { name: "Pair a passkey or hardware key", exact: true })
              .waitFor(),
          );
          expect(
            (yield* request("Enrollment does not create a session", "/api/auth/get-session")).body,
          ).toBeNull();
          expect(
            (yield* request(
              "Authentication options require user verification",
              "/api/auth/passkey/generate-authenticate-options",
            )).body.userVerification,
          ).toBe("required");
          yield* browser.use("Sign in with the verified passkey", (page) =>
            page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click(),
          );
          yield* browser.use("Owner enters the dashboard", (page) =>
            page.waitForURL((url) => url.pathname !== "/login"),
          );
          const current = (yield* request("Read owner identity", "/api/auth/get-session")).body;
          expect(current.user.id).toBe("private-owner");
          expect(current.session.activeOrganizationId).toBe("private-executor");
          yield* driver("Use a second hardware authenticator", () =>
            session.send("WebAuthn.removeVirtualAuthenticator", {
              authenticatorId: authenticator.authenticatorId,
            }),
          );
          yield* driver("Add a separate virtual hardware key", () =>
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
          yield* browser.use("Return to pair another key", (page) => page.goto("/login"));
          yield* pair;
          const keys = (yield* request(
            "Read both owner passkeys",
            "/api/auth/passkey/list-user-passkeys",
          )).body;
          expect(keys).toHaveLength(2);
          expect(keys.every((key: { userId: string }) => key.userId === "private-owner")).toBe(
            true,
          );
          const organizations = (yield* request(
            "Read the sole organization",
            "/api/auth/organization/list",
          )).body;
          expect(organizations.map((org: { id: string }) => org.id)).toEqual(["private-executor"]);
          for (const data of [
            { name: "No expiry", metadata: { organization: "private-executor" } },
            { name: "No pin", expiresIn: 300 },
            { name: "Foreign pin", expiresIn: 300, metadata: { organization: "foreign" } },
          ]) {
            expect(
              (yield* request(
                "Reject unbounded agent key",
                "/api/auth/api-key/create",
                "POST",
                data,
              )).status,
            ).toBe(403);
          }
          const created = yield* request(
            "Create revocable pinned agent key",
            "/api/auth/api-key/create",
            "POST",
            {
              name: "Revocable agent",
              expiresIn: 300,
              metadata: { organization: "private-executor" },
            },
          );
          expect(created.status).toBe(200);
          const key = created.body;
          const headers = { authorization: `Bearer ${key.key}` };
          expect(
            (yield* request(
              "Pinned key gets API access",
              "/api/context",
              "GET",
              undefined,
              headers,
            )).status,
          ).toBe(200);
          expect(
            (yield* request(
              "Agent key cannot enroll a passkey",
              "/api/auth/passkey/generate-register-options",
              "GET",
              undefined,
              headers,
            )).status,
          ).toBe(403);
          expect(
            (yield* request("Owner revokes agent key", "/api/auth/api-key/delete", "POST", {
              keyId: key.id,
            })).status,
          ).toBe(200);
          expect(
            (yield* request(
              "Revoked key loses API access",
              "/api/context",
              "GET",
              undefined,
              headers,
            )).status,
          ).toBe(401);
          const expiring = yield* request(
            "Create expiring agent key",
            "/api/auth/api-key/create",
            "POST",
            {
              name: "Expiring agent",
              expiresIn: 1,
              metadata: { organization: "private-executor" },
            },
          );
          expect(expiring.status).toBe(200);
          yield* request("Expired key loses API access", "/api/context", "GET", undefined, {
            authorization: `Bearer ${expiring.body.key}`,
          }).pipe(
            Effect.repeat({
              until: (response) => response.status === 401,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("5 seconds"),
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(401))),
          );
          const browserBoundary = yield* request(
            "Create a key to check browser isolation",
            "/api/auth/api-key/create",
            "POST",
            {
              name: "Browser isolation",
              expiresIn: 60,
              metadata: { organization: "private-executor" },
            },
          );
          expect(browserBoundary.status).toBe(200);
          expect(
            (yield* request("End owner browser session", "/api/auth/sign-out", "POST", {})).status,
          ).toBe(200);
          expect(
            (yield* request(
              "Live API key cannot become a browser session",
              "/api/auth/get-session",
              "GET",
              undefined,
              { authorization: `Bearer ${browserBoundary.body.key}` },
            )).body,
          ).toBeNull();
          yield* browser.checkpoint(
            "Multiple owner passkeys and revocable pinned agent keys verified",
          );
        }),
      ),
    { timeout: 60_000 },
  );
});
