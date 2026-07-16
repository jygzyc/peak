/** Cross-platform TypeScript build and dashboard asset copy. */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");
const command = process.argv[2] ?? "build";

if (command === "clean") {
  clean();
} else if (command === "copy-assets") {
  copyAssets();
} else if (command === "build") {
  clean();
  compile();
  copyAssets();
} else {
  process.stderr.write(`unknown build command: ${command}\n`);
  process.exitCode = 2;
}

function clean() {
  rmSync(distDir, { recursive: true, force: true });
  rmSync(join(root, "dist-packages"), { recursive: true, force: true });
}

function compile() {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function copyAssets() {
  mkdirSync(join(distDir, "server"), { recursive: true });
  cpSync(
    join(root, "src", "server", "dashboard.html"),
    join(distDir, "server", "dashboard.html"),
  );
}
