/** Cross-platform TypeScript build and asset copy. */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const command = process.argv[2] ?? "build";

if (command === "clean") clean();
else if (command === "copy-assets") copyAssets();
else if (command === "build") { clean(); compile(); copyAssets(); }
else throw new Error(`unknown build command: ${command}`);

function clean() {
  rmSync(dist, { recursive: true, force: true });
  rmSync(join(root, "dist-packages"), { recursive: true, force: true });
}
function compile() {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc")], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function copyAssets() {
  mkdirSync(join(dist, "ui"), { recursive: true });
  mkdirSync(join(dist, "runtime"), { recursive: true });
  cpSync(join(root, "src", "ui", "dashboard.html"), join(dist, "ui", "dashboard.html"));
  cpSync(join(root, "src", "runtime", "prompts"), join(dist, "runtime", "prompts"), { recursive: true });
}
