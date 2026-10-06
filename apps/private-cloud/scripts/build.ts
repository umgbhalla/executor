/** Bundle the private product and compiler for Wrangler's native module upload. */
import { readExecutorSkills } from "@executor-js/app-templates/executor";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { build, type Plugin } from "esbuild";
import { Effect } from "effect";
import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const root = path.resolve(app, "../..");
const output = path.join(app, "dist");
const web = path.join(root, "apps/hosted/self-host/web/dist/client");
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "modules"), { recursive: true });
const skills = Object.fromEntries(
  (await Effect.runPromise(readExecutorSkills.pipe(Effect.provide(NodeServices.layer)))).map(
    (file) => [file.path, file.content],
  ),
);
const dashboard = Object.fromEntries(
  (await readdir(web, { recursive: true }))
    .filter((name) => path.extname(name) !== "")
    .map((name) => [
      name.split(path.sep).join("/"),
      mime[path.extname(name)] ?? "application/octet-stream",
    ]),
);
const assets: Plugin = {
  name: "private-assets",
  setup(builder) {
    builder.onResolve({ filter: /^executor:(skills|dashboard)$/ }, ({ path: name }) => ({
      path: name,
      namespace: "private-assets",
    }));
    builder.onLoad({ filter: /.*/, namespace: "private-assets" }, ({ path: name }) => ({
      contents: `export default ${JSON.stringify(name === "executor:skills" ? skills : dashboard)}`,
      loader: "js",
    }));
  },
};
const compilerWasm: Plugin = {
  name: "private-compiler-wasm",
  setup(builder) {
    builder.onResolve({ filter: /\.wasm$/ }, async (args) => {
      if (args.pluginData?.resolvedWasm) return undefined;
      const resolved = await builder.resolve(args.path, {
        resolveDir: args.resolveDir,
        kind: args.kind,
        pluginData: { resolvedWasm: true },
      });
      if (resolved.errors.length || !resolved.path) throw new Error(`Cannot resolve ${args.path}`);
      const file = path.basename(resolved.path);
      await copyFile(resolved.path, path.join(output, "modules", file));
      return { path: `./modules/${file}`, external: true };
    });
  },
};
const external = ["node:*", "cloudflare:*"];
for (const [name, entry] of [
  ["product", "src/worker.ts"],
  ["compiler", "src/compiler.ts"],
] as const) {
  const outfile = path.join(output, `${name}.mjs`);
  const result = await build({
    absWorkingDir: app,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: name === "product" ? "node" : "browser",
    target: "es2022",
    conditions: ["workerd"],
    minify: true,
    keepNames: true,
    external,
    metafile: true,
    plugins: [assets, ...(name === "compiler" ? [compilerWasm] : [])],
  });
  if (
    name === "product" &&
    Object.keys(result.metafile.inputs).some((input) =>
      /(?:^|[/\\])(?:@electric-sql[/\\]pglite|@effect[/\\]sql-pglite|pglite-filesystem)(?:[/\\]|$)/.test(
        input,
      ),
    )
  )
    throw new Error("Private product bundle includes PGlite");
}
await cp(web, path.join(output, "web"), { recursive: true });
console.log("Built private Cloudflare modules");
