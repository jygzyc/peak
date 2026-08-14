/** Cross-platform TypeScript build and asset copy.
 *
 * Core and UI compile separately so an in-progress UI never blocks the core
 * build (CLI, Graph server, Runtime) or the test suite:
 *   build      = core only: clean + script checks + embed assets + tsc + runtime prompts
 *   build-ui   = UI only: bundle src/ui/app + re-embed assets + UI typecheck + copy dist/ui
 *   build-all  = both (previous monolithic `build`)
 *   copy-assets / copy-ui = copy-only steps (idempotent, no clean/compile)
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const command = process.argv[2] ?? "build";

if (command === "clean") clean();
else if (command === "copy-assets") copyCoreAssets();
else if (command === "copy-ui") copyUiAssets();
else if (command === "build") { clean(); checkScripts(); embedAssets(); compileCore(); copyCoreAssets(); }
else if (command === "build-ui") { bundleUi(); embedAssets(); typecheckUi(); copyUiAssets(); }
else if (command === "build-all") { clean(); checkScripts(); bundleUi(); embedAssets(); compileCore(); typecheckUi(); copyCoreAssets(); copyUiAssets(); }
else throw new Error(`unknown build command: ${command}`);

function clean() {
  rmSync(dist, { recursive: true, force: true });
  rmSync(join(root, "dist-packages"), { recursive: true, force: true });
}
function checkScripts() {
  // Validate the syntax and reference consistency of scripts/*.mjs before packaging,
  // so problems surface during the build rather than at runtime.
  const result = spawnSync(process.execPath, [join(root, "scripts", "check-scripts.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  // The script itself must also pass `node --check`.
  if (existsSync(join(root, "scripts", "check-scripts.mjs"))) {
    const self = spawnSync(process.execPath, ["--check", join(root, "scripts", "check-scripts.mjs")], { cwd: root, stdio: "inherit" });
    if (self.status !== 0) process.exit(self.status ?? 1);
  }
}
function bundleUi() {
  // Compile the Lit UI (TypeScript) into the single static bundle that the
  // HTML shells load, before embed-assets picks it up.
  const result = spawnSync(process.execPath, [join(root, "scripts", "bundle-ui.mjs")], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function embedAssets() {
  // Generate src/generated/assets.ts (prompts + version + whatever UI static
  // files exist, including the bundle when build-ui has produced it) before
  // tsc, otherwise src that references the generated file cannot compile.
  const result = spawnSync(process.execPath, [join(root, "scripts", "embed-assets.mjs")], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function compileCore() {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc")], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function typecheckUi() {
  // Type-check the browser UI app with its own tsconfig (DOM libs, bundler
  // resolution). Deliberately outside the core build: UI errors must not
  // block the CLI/Graph/Runtime dist.
  const ui = spawnSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "src", "ui", "app")],
    { cwd: root, stdio: "inherit" },
  );
  if (ui.status !== 0) process.exit(ui.status ?? 1);
}
function copyCoreAssets() {
  mkdirSync(join(dist, "runtime"), { recursive: true });
  cpSync(join(root, "src", "runtime", "prompts"), join(dist, "runtime", "prompts"), { recursive: true });
}
function copyUiAssets() {
  mkdirSync(join(dist, "ui"), { recursive: true });
  // Copy the whole ui/ static site (html + scripts/ + assets/), skipping
  // TypeScript sources: the browser app is bundled into scripts/app.js and
  // the server module is emitted by tsc.
  cpSync(join(root, "src", "ui"), join(dist, "ui"), {
    recursive: true,
    filter: (source) => !source.endsWith(".ts") && !source.includes(join("src", "ui", "app") + sep),
  });
}
