import { readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";

const { values } = parseArgs({
  options: {
    env: { type: "string" },
    token: { type: "string", default: "CLOUDFLARE_API_TOKEN" },
    domain: { type: "string", default: "umgbhalla.com" },
  },
});
if (!values.env) throw new Error("Use --env <private environment file> [--token <variable name>]");
const env = parseEnv(readFileSync(values.env, "utf8"));
const account = env.CLOUDFLARE_ACCOUNT_ID;
const token = env[values.token];
if (!/^[a-f0-9]{32}$/.test(account ?? "") || !token) {
  throw new Error("The selected token and a valid CLOUDFLARE_ACCOUNT_ID are required.");
}

let failed = false;
async function check(name, path) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    const ok = response.ok && body.success === true;
    failed ||= !ok;
    // API errors can contain request details. Emit only status and numeric codes.
    console.log(
      JSON.stringify({
        check: name,
        ok,
        http: response.status,
        errors: (body.errors ?? []).map((error) => error.code),
      }),
    );
    return ok ? body.result : undefined;
  } catch {
    failed = true;
    console.log(JSON.stringify({ check: name, ok: false, error: "Request failed" }));
    return undefined;
  }
}

const [verification, , , , zones] = await Promise.all([
  check("token", "user/tokens/verify"),
  check("Workers", `accounts/${account}/workers/scripts`),
  check("R2", `accounts/${account}/r2/buckets`),
  check("Durable Objects", `accounts/${account}/workers/durable_objects/namespaces`),
  check("DNS zone", `zones?name=${encodeURIComponent(values.domain)}`),
]);
if (verification !== undefined && verification.status !== "active") {
  failed = true;
  console.log(JSON.stringify({ check: "active token", ok: false }));
}
if (zones?.length === 1 && zones[0].status === "active") {
  await check(
    "dashboard DNS",
    `zones/${zones[0].id}/dns_records?name=${encodeURIComponent(`executor.${values.domain}`)}`,
  );
} else {
  failed = true;
  console.log(JSON.stringify({ check: "one active DNS zone", ok: false }));
}
console.log(
  JSON.stringify({
    accessReady: !failed,
    deploymentReady: false,
    note: "Read access does not prove write access. The private Cloudflare runtime is not implemented.",
  }),
);
process.exitCode = failed ? 1 : 0;
