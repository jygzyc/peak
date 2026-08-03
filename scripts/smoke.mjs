import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "peak-smoke-"));
const cli = join(root, "dist", "cli.js");

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

try {
  const target = join(workspace, "task");
  const initialized = run(["init", target]);
  if (!initialized.includes("created:") || !existsSync(join(target, "task.json"))) {
    throw new Error("peak init failed");
  }
  const defaultTarget = join(workspace, "default-task");
  mkdirSync(defaultTarget);
  run(["init"], defaultTarget);
  if (!existsSync(join(defaultTarget, "task.json"))) {
    throw new Error("peak init current-directory default failed");
  }
  const workers = run(["workers"]);
  for (const value of ["opencode", "codex", "pi", "claude-code", "plan", "supervise", "execute"]) {
    if (!workers.includes(value)) throw new Error(`workers output missing ${value}`);
  }
  // 版本号必须与根目录 version 文件一致。
  const version = run(["--version"]).trim();
  const expected = readFileSync(join(root, "version"), "utf8").trim();
  if (version !== expected) throw new Error(`peak --version (${version}) !== version 文件 (${expected})`);
  console.log("smoke ok");
} finally { rmSync(workspace, { recursive: true, force: true }); }
