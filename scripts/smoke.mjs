/**
 * Smoke test for the current peak CLI/runtime wiring.
 *
 * This intentionally stays shallow: unit tests cover graph/stage behavior; smoke
 * verifies that the built CLI can load config, run a task with MockWorker, list
 * worker capabilities, and initialize a minimal task file under ESM.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// fileURLToPath (not URL.pathname) so the repo root resolves correctly on
// Windows — pathname yields a malformed "\\E:\\Code\\" drive path there.
const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "peak-smoke-"));
const cli = join(root, "dist", "cli.js");

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `(no output, status=${result.status}, signal=${result.signal})`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

try {
  const taskPath = join(workspace, "task.json");
  writeFileSync(taskPath, JSON.stringify({
    task: { target: "input.apk", goal: "smoke test current runtime wiring", session: "smoke-session" },
  }, null, 2));

  const runOut = run(["run", taskPath, "--mock", "--no-http", "--no-metacog"]);
  for (const expected of [
    "[peak] session: smoke-session",
    "[peak] target: input.apk",
    "[peak] running...",
    // Natural termination: MockWorker.registerDefaults() drives the planner to
    // open one intent, the explorer resolves it, the evaluator accepts it, and
    // on the next planner tick (empty intents + recent accept) the planner
    // concludes the run → openIntents hits 0 → project completes.
    "[peak] finished: completed",
  ]) {
    if (!runOut.includes(expected)) {
      process.stderr.write(`smoke run output missing: ${expected}\n${runOut}`);
      process.exit(1);
    }
  }

  const workersOut = run(["workers"]);
  for (const expected of ["workers", "driverKinds", "agentBackends", "modelProviders", "api", "agent"]) {
    if (!workersOut.includes(expected)) {
      process.stderr.write(`workers output missing: ${expected}\n${workersOut}`);
      process.exit(1);
    }
  }

  const initDir = join(workspace, "init-target");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(initDir, { recursive: true });
  const initOut = run(["init", initDir]);
  const initTask = join(initDir, "task.json");
  if (!existsSync(initTask) || !initOut.includes("created:")) {
    process.stderr.write(`init did not create task.json\n${initOut}`);
    process.exit(1);
  }

  console.log("smoke ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
