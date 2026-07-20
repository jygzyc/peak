/**
 * Smoke test for the current peak CLI/runtime wiring.
 *
 * This intentionally stays shallow: unit tests cover graph/stage behavior; smoke
 * verifies that the built CLI can load config, run a task with MockWorker, list
 * worker capabilities, and initialize a complete task workspace under ESM.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// fileURLToPath (not URL.pathname) so the repo root resolves correctly on
// Windows — pathname yields a malformed "\\E:\\Code\\" drive path there.
const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "peak-smoke-"));
const peakHome = join(workspace, "peak-home");
const cli = join(root, "dist", "cli.js");
mkdirSync(peakHome, { recursive: true });

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
    env: { ...process.env, PEAK_HOME: peakHome, ...options.env },
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
    task: { name: "smoke-session", target: "input.apk", goal: "smoke test current runtime wiring" },
  }, null, 2));

  const runOut = run(["run", taskPath, "--mock", "--no-http"]);
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

  const activeText = readFileSync(join(peakHome, "sessions", ".session.yaml"), "utf8");
  const sessionId = /^\s*id:\s*([0-9a-f-]+)\s*$/mi.exec(activeText)?.[1];
  if (!sessionId) {
    process.stderr.write(`active Session UUID missing\n${activeText}`);
    process.exit(1);
  }
  const sessionDir = join(peakHome, "sessions", sessionId);
  const logs = readdirSync(join(sessionDir, "logs"));
  for (const expected of ["analysis.db", "logs/main.log"]) {
    if (!existsSync(join(sessionDir, ...expected.split("/")))) {
      process.stderr.write(`Session state missing: ${expected}`);
      process.exit(1);
    }
  }
  if (!logs.some((name) => /-planner-context\.json$/.test(name))
    || !logs.some((name) => /-planner-output\.json$/.test(name))) {
    process.stderr.write(`timestamped role logs missing: ${logs.join(", ")}`);
    process.exit(1);
  }
  if (existsSync(join(peakHome, "federation.db")) || existsSync(join(sessionDir, "agents"))) {
    process.stderr.write("obsolete federation.db or runtime agents directory was created");
    process.exit(1);
  }

  const workersOut = run(["workers"]);
  for (const expected of ["workerTypes", "opencode", "codex", "pi", "claude-code"]) {
    if (!workersOut.includes(expected)) {
      process.stderr.write(`workers output missing: ${expected}\n${workersOut}`);
      process.exit(1);
    }
  }

  const initDir = join(workspace, "init-target");
  mkdirSync(initDir, { recursive: true });
  const initOut = run(["init", initDir]);
  const initTask = join(initDir, "task.json");
  const initAgent = join(initDir, "task-agent.json");
  const initSkills = join(initDir, "skills");
  if (!existsSync(initTask) || !existsSync(initAgent) || !existsSync(initSkills)
    || !initOut.includes("created:")) {
    process.stderr.write(`init did not create task.json, task-agent.json, and skills/\n${initOut}`);
    process.exit(1);
  }
  run(["run", initTask, "--mock", "--no-http", "--session", "initialized-task"]);

  console.log("smoke ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
