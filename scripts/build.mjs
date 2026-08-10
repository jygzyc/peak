/** Cross-platform TypeScript build and asset copy. */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const command = process.argv[2] ?? "build";

if (command === "clean") clean();
else if (command === "copy-assets") copyAssets();
else if (command === "build") { clean(); checkScripts(); embedAssets(); compile(); copyAssets(); }
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
function embedAssets() {
  // Generate src/generated/assets.ts before tsc, otherwise src that references the generated file cannot compile.
  const result = spawnSync(process.execPath, [join(root, "scripts", "embed-assets.mjs")], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function compile() {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc")], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function copyAssets() {
  mkdirSync(join(dist, "ui"), { recursive: true });
  mkdirSync(join(dist, "runtime"), { recursive: true });
  for (const name of ["dashboard.html", "preview.html", "tasks.html"]) {
    cpSync(join(root, "src", "ui", name), join(dist, "ui", name));
  }
  cpSync(join(root, "src", "runtime", "prompts"), join(dist, "runtime", "prompts"), { recursive: true });
}
