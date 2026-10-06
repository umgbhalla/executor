import type { Plugin } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

type WorkerModule = { name: string; file: string; type: "compiled-wasm" | "buffer" };

/** Prepare the pinned Emscripten binaries without granting runtime code compilation. */
export async function createPgliteBuild(outputDirectory: string): Promise<{
  plugin: Plugin;
  modules: WorkerModule[];
}> {
  const require = createRequire(new URL("../../hosted/self-host/package.json", import.meta.url));
  const directory = path.dirname(require.resolve("@electric-sql/pglite"));
  const packageJson = JSON.parse(await readFile(path.join(directory, "../package.json"), "utf8"));
  if (packageJson.version !== "0.5.8")
    throw new Error("Static PGlite adapter requires version 0.5.8");
  const sources = await Promise.all(
    ["pglite.js", "initdb.js"].map((name) => readFile(path.join(directory, name), "utf8")),
  );
  const signatures = new Set(["ii", "iii"]);
  for (const source of sources)
    for (const match of source.matchAll(/(?:\.sig="([vipjfde]+)"|invoke_([vipjfde]+))/g))
      signatures.add((match[1] ?? match[2]!).replaceAll("p", "i"));
  if (signatures.size !== 65)
    throw new Error("PGlite callback signatures changed; review the adapter");
  await mkdir(outputDirectory, { recursive: true });
  const modules: WorkerModule[] = [];
  for (const name of ["pglite.wasm", "initdb.wasm", "pglite.data"]) {
    const file = path.join(outputDirectory, name);
    await copyFile(path.join(directory, name), file);
    if (name.endsWith(".wasm") && !WebAssembly.validate(await readFile(file)))
      throw new Error(`Invalid PGlite WebAssembly: ${name}`);
    modules.push({
      name: `executor:${name}`,
      file,
      type: name.endsWith(".wasm") ? "compiled-wasm" : "buffer",
    });
  }
  const imports: string[] = [];
  const entries: string[] = [];
  for (const [index, signature] of [...signatures].sort().entries()) {
    const codes: Record<string, number> = { i: 127, j: 126, f: 125, d: 124, e: 111 };
    const type = [
      1,
      96,
      signature.length - 1,
      ...Array.from(signature.slice(1), (c) => codes[c]!),
      ...(signature[0] === "v" ? [0] : [1, codes[signature[0]!]!]),
    ];
    const bytes = Uint8Array.from([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      1,
      type.length,
      ...type,
      2,
      7,
      1,
      1,
      101,
      1,
      102,
      0,
      0,
      7,
      5,
      1,
      1,
      102,
      0,
      0,
    ]);
    if (!WebAssembly.validate(bytes)) throw new Error(`Invalid callback WebAssembly: ${signature}`);
    const name = `executor:pg-callback-${signature}.wasm`;
    const file = path.join(outputDirectory, `pg-callback-${signature}.wasm`);
    await writeFile(file, bytes);
    modules.push({ name, file, type: "compiled-wasm" });
    imports.push(`import c${index} from ${JSON.stringify(name)};`);
    entries.push(`${JSON.stringify(signature)}:c${index}`);
  }
  // Hosted schema triggers use LANGUAGE plpgsql; no third-party extension is admitted here.
  const metadata = sources[0]!.match(
    /\{filename:"\/pglite\/lib\/postgresql\/plpgsql\.so",start:(\d+),end:(\d+)\}/,
  );
  if (!metadata) throw new Error("PGlite plpgsql package metadata changed");
  const start = Number(metadata[1]),
    end = Number(metadata[2]);
  const data = await readFile(path.join(directory, "pglite.data"));
  const library = data.subarray(start, end);
  if (!WebAssembly.validate(library)) throw new Error("Invalid bundled plpgsql WebAssembly");
  const libraryFile = path.join(outputDirectory, "plpgsql.wasm");
  await writeFile(libraryFile, library);
  modules.push({ name: "executor:plpgsql.wasm", file: libraryFile, type: "compiled-wasm" });
  const virtualSource = `${imports.join("\n")}
import plpgsql from "executor:plpgsql.wasm";
import packageData from "executor:pglite.data";
const callbacks={${entries.join(",")}};
export function callback(func,sig){
  const module=callbacks[sig?.replaceAll("p","i")];
  if(!module) throw new Error("Unsupported PGlite callback signature: "+sig);
  return new WebAssembly.Instance(module,{e:{f:func}}).exports.f;
}
export function library(binary,name){
  if(binary instanceof WebAssembly.Module) return binary;
  const bytes=new Uint8Array(binary.buffer??binary,binary.byteOffset??0,binary.byteLength);
  const expected=new Uint8Array(packageData,${start},${end - start});
  if(!name.endsWith("plpgsql.so") || bytes.length!==expected.length || bytes.some((b,i)=>b!==expected[i]))
    throw new Error("Unsupported dynamic PGlite extension: "+name);
  return plpgsql;
}`;
  return {
    modules,
    plugin: {
      name: "private-pglite-static-wasm",
      setup(builder) {
        builder.onResolve({ filter: /^executor:pg-callbacks$/ }, () => ({
          path: "callbacks",
          namespace: "pg-static",
        }));
        builder.onLoad({ filter: /.*/, namespace: "pg-static" }, () => ({
          contents: virtualSource,
          loader: "js",
        }));
        builder.onLoad(
          { filter: /@electric-sql\/pglite\/dist\/.*\.js$/ },
          async ({ path: file }) => {
            let source = await readFile(file, "utf8");
            if (source.includes("convertJsFunctionToWasm=")) {
              const converter =
                /convertJsFunctionToWasm=\([^)]*\)=>\{.*?\}(?=,wasmTableMirror|;var wasmTableMirror)/g;
              const loader = "loadWebAssemblyModule=(binary,flags,libName,localScope,handle)=>{";
              if ([...source.matchAll(converter)].length !== 1 || source.split(loader).length !== 2)
                throw new Error(`PGlite Emscripten source changed: ${file}`);
              source = source
                .replace(converter, "convertJsFunctionToWasm=__pgCallback")
                .replace(loader, loader + "binary=__pgLibrary(binary,libName);");
              source =
                'import {callback as __pgCallback,library as __pgLibrary} from "executor:pg-callbacks";\n' +
                source;
            }
            return {
              contents: source
                .replaceAll("import.meta.url", JSON.stringify("https://pglite.invalid/pglite.js"))
                .replaceAll(
                  "self.location.href",
                  JSON.stringify("https://pglite.invalid/pglite.js"),
                )
                .replaceAll("process.versions.node", "undefined"),
              loader: "js",
            };
          },
        );
      },
    },
  };
}
