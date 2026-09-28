import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
assert.ok(["@bybrawe/opencode-loop", "@bybrawe/opencode-goal"].includes(pkg.name))
assert.ok(process.argv.length <= 3, "expected at most one consumer directory")
const loop = pkg.name === "@bybrawe/opencode-loop"
const cwd = process.argv[2] ? path.resolve(process.argv[2]) : root
const packageRoot = process.argv[2] ? path.join(cwd, "node_modules", ...pkg.name.split("/")) : root
const url = (relative) => pathToFileURL(path.join(packageRoot, relative)).href
const legacyEntries = loop ? [url("src/v1.js"), url("src/source/v1.js")] : [url("dist/legacy-v1.js")]
const blocked = loop
  ? [...legacyEntries, url("src/index.js"), url("src/source/legacy-v1.js")]
  : [...legacyEntries, url("dist/index.js"), url("dist/opencode/plugin.js")]
const entries = loop ? [pkg.name, `${pkg.name}/server`, `${pkg.name}/v2`] : [`${pkg.name}/server`, `${pkg.name}/v2`]
if (loop) entries.push(url("src/source/server.js"))
const serverEntries = loop ? [`${pkg.name}/server`, url("src/source/server.js")] : [`${pkg.name}/server`]

function probe(mode) {
  const stub = "globalThis.__legacyModuleLoads = (globalThis.__legacyModuleLoads || 0) + 1; export default async (...args) => { if (args[0]?.failure) throw args[0].failure; return { args }; }"
  const loader = `
    const blocked = ${JSON.stringify(blocked)};
    const legacyEntries = ${JSON.stringify(legacyEntries)};
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@opencode-ai/")) throw new Error("V2_LEGACY_IMPORT: " + specifier);
      const result = await nextResolve(specifier, context);
      if (${JSON.stringify(mode)} === "delegate" && legacyEntries.includes(result.url)) {
        return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)}, shortCircuit: true };
      }
      if (blocked.includes(result.url)) throw new Error("V2_LEGACY_IMPORT: " + result.url);
      return result;
    }
  `
  const source = `
    import assert from "node:assert/strict";
    import { register } from "node:module";
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
    const entries = ${JSON.stringify(mode === "isolation" ? entries : serverEntries)};
    for (const entry of entries) {
      const { default: plugin } = await import(entry);
      assert.equal(typeof plugin.setup, "function", entry);
      assert.equal(plugin.id, "@bybrawe/opencode-loop", entry);
      if (${JSON.stringify(mode)} === "isolation") {
        assert.equal(globalThis.__legacyModuleLoads, undefined, "native import initialized legacy runtime");
        if (entry.endsWith("/v2")) assert.equal("server" in plugin, false, "native entry must not expose V1 dispatch");
      } else {
        const before = globalThis.__legacyModuleLoads;
        if (entry === entries[0]) assert.equal(before, undefined, "server eagerly initialized V1");
        const input = { directory: "fixture-one" }, options = { fixture: true };
        const first = await plugin.server(input, options);
        assert.strictEqual(first.args[0], input, "legacy input was changed");
        assert.strictEqual(first.args[1], options, "legacy options were lost");
        const secondInput = { directory: "fixture-two" };
        const second = await plugin.server(secondInput, options);
        assert.strictEqual(second.args[0], secondInput, "plugin instances shared the first host context");
        assert.notStrictEqual(first, second, "legacy hooks must be created for every invocation");
        const failure = new Error("legacy sentinel");
        await assert.rejects(plugin.server({ failure }), (error) => error === failure, "legacy failure was swallowed");
        assert.equal(globalThis.__legacyModuleLoads, 1, "only the module, never per-host hooks, is cached");
      }
    }
    console.log(${JSON.stringify(`native entry ${mode} PASS`)});
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
  process.stdout.write(result.stdout)
}

probe("isolation")
probe("delegate")
