import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { dashboardAuthClientOptions } from "@executor-js/ui/contracts/http";
import { LoginFrame } from "@executor-js/hosted-web/pages/login-frame";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { useState } from "react";

const auth = createAuthClient({ ...dashboardAuthClientOptions, plugins: [passkeyClient()] });

/** The manual key exists only in the submitted form; the server grants enrollment, not login. */
export function PrivateLoginPage({ redirect }: { readonly redirect: string }) {
  const [paired, setPaired] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<{ error: unknown }>, success: () => void) => {
    setPending(true);
    setError(null);
    try {
      const result = await operation();
      if (result.error) setError("This action failed. Check your key and try again.");
      else success();
    } catch {
      setError("This action failed. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <LoginFrame title="Private Executor">
      <div className="flex flex-col gap-4">
        <Button
          disabled={pending}
          onClick={() =>
            run(
              () => auth.signIn.passkey(),
              () => {
                const destination = new URL(redirect, window.location.origin);
                window.location.assign(
                  destination.origin === window.location.origin ? destination.href : "/",
                );
              },
            )
          }
        >
          Sign in with a passkey
        </Button>
        {!paired ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const key = String(new FormData(form).get("key"));
              form.reset();
              void run(
                () => auth.$fetch("/private/pair", { method: "POST", body: { key } }),
                () => setPaired(true),
              );
            }}
          >
            <label className="flex flex-col gap-2">
              Pairing key
              <Input
                name="key"
                type="password"
                required
                minLength={32}
                maxLength={512}
                autoComplete="off"
              />
            </label>
            <Button variant="outline" disabled={pending}>
              Pair a passkey or hardware key
            </Button>
          </form>
        ) : (
          <>
            <p>Pairing is valid for five minutes. Add your key, then sign in.</p>
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () => auth.passkey.addPasskey({ name: "Owner key" }),
                  () => setPaired(false),
                )
              }
            >
              Add a passkey or hardware key
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </LoginFrame>
  );
}
