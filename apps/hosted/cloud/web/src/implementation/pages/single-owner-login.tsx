import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { LoginFrame } from "@executor-js/hosted-web/pages/login-frame";
import { ContinueAfterSignIn, type LoginProps } from "@executor-js/hosted-web/pages/login";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { AsyncResult } from "effect/reactivity";
import { Exit } from "effect";
import { useState } from "react";
import { addPasskeyAtom, pairOwnerAtom, passkeySignInAtom } from "../../contracts/auth.ts";

/** Pairing permits enrollment; only a verified passkey opens the dashboard. */
export function SingleOwnerLoginPage({ redirect }: LoginProps) {
  const session = useAtomValue(sessionAtom);
  const pair = useAtomSet(pairOwnerAtom, { mode: "promiseExit" });
  const register = useAtomSet(addPasskeyAtom, { mode: "promiseExit" });
  const signIn = useAtomSet(passkeySignInAtom, { mode: "promiseExit" });
  const pairing = useAtomValue(pairOwnerAtom);
  const registering = useAtomValue(addPasskeyAtom);
  const signing = useAtomValue(passkeySignInAtom);
  const [showPairing, setShowPairing] = useState(false);
  const [paired, setPaired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pending = pairing.waiting || registering.waiting || signing.waiting;
  if (AsyncResult.isSuccess(session) && !session.waiting && session.value !== null)
    return <ContinueAfterSignIn redirect={redirect} userId={session.value.user.id} />;
  return (
    <LoginFrame title="Private Executor">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          One owner. Sign in with your passkey or security key.
        </p>
        <Button
          className="w-full"
          disabled={pending}
          loading={signing.waiting}
          onClick={async () => {
            setError(null);
            const result = await signIn(redirect);
            if (Exit.isFailure(result)) setError("Sign-in failed. Try your passkey again.");
          }}
        >
          Sign in with a passkey
        </Button>
        {paired ? (
          <Button
            className="w-full"
            variant="outline"
            disabled={pending}
            loading={registering.waiting}
            onClick={async () => {
              setError(null);
              const result = await register("Owner passkey");
              if (Exit.isFailure(result))
                setError("Passkey was not added. Try again or pair this browser again.");
              else {
                setPaired(false);
                setShowPairing(false);
                setMessage("Passkey added. Sign in to continue.");
              }
            }}
          >
            Register passkey
          </Button>
        ) : showPairing ? (
          <form
            className="settings-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const key = String(new FormData(event.currentTarget).get("key"));
              event.currentTarget.reset();
              setError(null);
              setMessage(null);
              const result = await pair(key);
              if (Exit.isFailure(result))
                setError("Pairing failed. Check your pairing key and try again.");
              else setPaired(true);
            }}
          >
            <label>
              Pairing key
              <Input
                name="key"
                type="password"
                autoComplete="off"
                required
                minLength={32}
                maxLength={512}
                disabled={pending}
              />
            </label>
            <p className="text-sm text-muted-foreground">
              Use your pairing key to add a passkey on this browser.
            </p>
            <Button variant="outline" disabled={pending} loading={pairing.waiting}>
              Pair this browser
            </Button>
          </form>
        ) : (
          <Button
            className="w-full"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setShowPairing(true);
              setMessage(null);
            }}
          >
            Pair this browser
          </Button>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </div>
    </LoginFrame>
  );
}
