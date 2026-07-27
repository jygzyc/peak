import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "peak-smoke-"));
const cli = join(root, "dist", "cli.js");

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

try {
  const target = join(workspace, "task");
  const initialized = run(["init", target]);
  if (!initialized.includes("created:") || !existsSync(join(target, "task.json")) || !existsSync(join(target, "skills"))) {
    throw new Error("peak init failed");
  }
  const workers = run(["workers"]);
  for (const value of ["opencode", "codex", "pi", "claude-code", "plan", "supervise", "execute"]) {
    if (!workers.includes(value)) throw new Error(`workers output missing ${value}`);
  }
  console.log("smoke ok");
} finally { rmSync(workspace, { recursive: true, force: true }); }
