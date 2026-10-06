/** Deploy a disposable stage by default; --production attaches the owner domain. */
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(app, "dist");
const privateDirectory =
  process.env.EXECUTOR_PRIVATE_STATE ?? path.join(os.homedir(), ".local/state/executor-private");
const production = process.argv.includes("--production");
const stage = process.argv.includes("--stage") || !production;
if (production && process.argv.includes("--stage")) throw new Error("Choose one deployment stage");
const originFlag = process.argv.find((value) => value.startsWith("--origin="));

function parseEnv(value: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const raw = match[2]!;
    entries[match[1]!] =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
  }
  return entries;
}
const deployment = parseEnv(await readFile(path.join(privateDirectory, "deploy.env"), "utf8"));
const privateValues = parseEnv(await readFile(path.join(privateDirectory, "private.env"), "utf8"));
const needed = (values: Record<string, string>, key: string) => {
  const value = values[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
const accountId = needed(deployment, "CLOUDFLARE_ACCOUNT_ID");
const token = needed(deployment, "CLOUDFLARE_API_TOKEN");
const name = production ? "executor-private" : "executor-private-stage";
const hyperdriveId = needed(
  deployment,
  production ? "EXECUTOR_PRODUCTION_HYPERDRIVE_ID" : "EXECUTOR_STAGE_HYPERDRIVE_ID",
);
const databaseUrl = needed(
  deployment,
  production ? "EXECUTOR_PRODUCTION_DATABASE_URL" : "EXECUTOR_STAGE_DATABASE_URL",
);
if (!/^[a-f0-9]{32}$/.test(hyperdriveId)) throw new Error("Invalid Hyperdrive configuration ID");
const hyperdriveResponse = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs/${hyperdriveId}`,
  { headers: { Authorization: `Bearer ${token}` } },
);
if (!hyperdriveResponse.ok) throw new Error("Cannot verify the Hyperdrive configuration");
const hyperdrive = (await hyperdriveResponse.json()) as {
  success?: boolean;
  result?: { caching?: { disabled?: boolean } };
};
if (hyperdrive.success !== true || hyperdrive.result?.caching?.disabled !== true)
  throw new Error("Hyperdrive query caching must be disabled for private Executor");
let origin = production ? "https://executor.umgbhalla.com" : originFlag?.slice("--origin=".length);
if (!origin) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Cannot find workers.dev subdomain (${response.status})`);
  const answer = (await response.json()) as { result?: { subdomain?: string } };
  const subdomain = answer.result?.subdomain;
  if (!subdomain || !/^[a-z0-9-]+$/.test(subdomain))
    throw new Error("Cloudflare returned no workers.dev subdomain");
  origin = `https://${name}.${subdomain}.workers.dev`;
}
if (new URL(origin).protocol !== "https:") throw new Error("Origin must use HTTPS");
const compiler = `${name}-compiler`;
const outbound = `${name}-outbound`;
const artifacts = `${name}-apps`;
const vars = {
  BETTER_AUTH_URL: origin,
  CLOUDFLARE_ACCOUNT_ID: accountId,
  ARTIFACTS_NAMESPACE: artifacts,
  ...(production ? { EXECUTOR_APP_UI_BASE_URL: "https://umgbhalla.com" } : {}),
};
const secrets = {
  BETTER_AUTH_SECRET: needed(privateValues, "BETTER_AUTH_SECRET"),
  EXECUTOR_ENCRYPTION_KEY: needed(privateValues, "EXECUTOR_ENCRYPTION_KEY"),
  EXECUTOR_PAIRING_KEY: needed(privateValues, "EXECUTOR_PRIVATE_PAIRING_KEY"),
  APP_CREDENTIAL_KEY: createHmac("sha256", needed(privateValues, "EXECUTOR_ENCRYPTION_KEY"))
    .update(`executor-app-credentials:${name}`)
    .digest("hex"),
};
if (!process.argv.includes("--dry-run")) {
  try {
    await execute(process.execPath, [path.join(app, "scripts/migrate.ts")], {
      cwd: app,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
        EXECUTOR_PAIRING_KEY: secrets.EXECUTOR_PAIRING_KEY,
      },
    });
  } catch {
    throw new Error("Private database migration failed; Worker deployment stopped");
  }
}
const common = {
  account_id: accountId,
  compatibility_date: "2026-10-01",
  no_bundle: true,
  workers_dev: !production,
  keep_vars: true,
};
const productConfig = {
  ...common,
  name,
  main: "./product.mjs",
  compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
  vars,
  routes: production ? [{ pattern: "executor.umgbhalla.com", custom_domain: true }] : [],
  assets: { directory: "./web", binding: "ASSETS", run_worker_first: true },
  rules: [
    {
      type: "CompiledWasm",
      globs: [
        "modules/pglite.wasm",
        "modules/initdb.wasm",
        "modules/plpgsql.wasm",
        "modules/pg-callback-*.wasm",
      ],
      fallthrough: false,
    },
    { type: "Data", globs: ["modules/pglite.data"], fallthrough: false },
  ],
  find_additional_modules: true,
  base_dir: ".",
  preserve_file_names: true,
  durable_objects: {
    bindings: [
      { name: "PRODUCT", class_name: "ExecutorProduct" },
      { name: "APP_DATA", class_name: "AppDataSupervisor" },
    ],
  },
  exports: {
    ExecutorProduct: { type: "durable-object", storage: "sqlite" },
    AppDataSupervisor: { type: "durable-object", storage: "sqlite" },
  },
  worker_loaders: [{ binding: "APP_LOADER" }],
  artifacts: [{ binding: "ARTIFACTS", namespace: artifacts }],
  hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdriveId }],
  workflows: [{ binding: "APP_WORKFLOWS", name: `${name}-workflows`, class_name: "AppWorkflows" }],
  r2_buckets: [{ binding: "APP_BUILDS", bucket_name: `${name}-builds` }],
  services: [
    { binding: "APP_COMPILER", service: compiler },
    { binding: "APP_RUNNER", service: name, entrypoint: "AppRunner" },
    { binding: "APP_OUTBOUND", service: outbound },
    { binding: "APP_WORKFLOW_HOST", service: name, entrypoint: "WorkflowCallbacks" },
  ],
};
const compilerConfig = {
  ...common,
  name: compiler,
  main: "./compiler.mjs",
  workers_dev: false,
  compatibility_flags: ["nodejs_compat"],
  rules: [
    {
      type: "CompiledWasm",
      globs: ["modules/esbuild.wasm", "modules/tailwindcss_oxide_bg.wasm"],
      fallthrough: false,
    },
  ],
  find_additional_modules: true,
  base_dir: ".",
  preserve_file_names: true,
};
const outboundConfig = {
  ...common,
  name: outbound,
  main: "./outbound/index.mjs",
  workers_dev: false,
  compatibility_flags: ["global_fetch_strictly_public"],
};
if (stage && !process.argv.includes("--dry-run")) {
  const bucket = `${name}-builds`;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const existing = await fetch(`${endpoint}/${bucket}`, { headers });
  if (existing.status === 404) {
    const created = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: bucket }),
    });
    if (!created.ok) throw new Error(`Cannot create stage R2 bucket (${created.status})`);
  } else if (!existing.ok) {
    throw new Error(`Cannot inspect stage R2 bucket (${existing.status})`);
  }
}
await mkdir(path.join(output, "outbound"), { recursive: true });
await writeFile(
  path.join(output, "outbound/index.mjs"),
  "export default { fetch(request) { return fetch(request); } };\n",
);
const ephemeral = await mkdtemp(path.join(os.tmpdir(), "executor-private-deploy-"));
try {
  const secretFile = path.join(ephemeral, "secrets.json");
  await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600 });
  for (const [script, config] of [
    [outbound, outboundConfig],
    [compiler, compilerConfig],
    [name, productConfig],
  ] as const) {
    const configFile = path.join(output, `${script}.wrangler.json`);
    await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
    const args = ["--yes", "wrangler@4.145.0", "deploy", "--config", configFile];
    if (script === name) args.push("--secrets-file", secretFile);
    if (process.argv.includes("--dry-run")) args.push("--dry-run");
    const { stdout, stderr } = await execute("npx", args, {
      cwd: app,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token },
      maxBuffer: 16 * 1024 * 1024,
    });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
} finally {
  await rm(ephemeral, { recursive: true, force: true });
}
console.log(`${stage ? "Stage" : "Production"} deployed: ${origin}`);
