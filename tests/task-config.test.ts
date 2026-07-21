import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config/task-config.js";

function setup(task: unknown, agent?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "peak-task-config-"));
  const taskPath = join(root, "task.json");
  writeFileSync(taskPath, JSON.stringify(task), "utf8");
  if (agent) writeFileSync(join(root, "custom.json"), JSON.stringify(agent), "utf8");
  return { root, taskPath };
}

test("loadConfig loads a project-local task with native roles by default", () => {
  const { taskPath, root } = setup({
    task: { target: "app.apk", goal: "find vulnerabilities", workspace: "." },
    workers: { opencode: { type: "opencode" } },
  });
  const loaded = loadConfig(taskPath);
  assert.equal(loaded.session, "app");
  assert.equal(loaded.workspaceDir, root);
  assert.equal(loaded.config.agent, undefined);
  assert.deepEqual(Object.values(loaded.config.profiles).map((profile) => profile.role).sort(), [
    "evaluator", "explorer", "metacog", "planner",
  ]);
});

test("loadConfig loads one Agent bundle and validates each referenced Worker", () => {
  const { taskPath } = setup({
    task: { target: "app.apk", goal: "find vulnerabilities", name: "app-vulnhunt" },
    agent: "custom",
    workers: {
      planner: { type: "opencode", model: "anthropic/sonnet" },
      gather: { type: "codex", model: "gpt-codex" },
      deep: { type: "pi", model: "openai/gpt" },
      opencode: { type: "claude-code", model: "sonnet" },
    },
  }, {
    roles: {
      planner_vuln: { role: "planner", worker: "planner" },
      explorer_gather: { role: "explorer", worker: "gather" },
      explorer_analysis: { role: "explorer", worker: "deep" },
    },
  });
  const loaded = loadConfig(taskPath);
  assert.equal(loaded.session, "app-vulnhunt");
  assert.equal(loaded.config.agent, "custom");
  assert.equal(loaded.config.profiles.planner_vuln?.runtime.worker, "planner");
  assert.equal(loaded.config.profiles.explorer_gather?.runtime.worker, "gather");
  assert.equal(loaded.config.profiles.explorer_analysis?.runtime.worker, "deep");
  assert.equal(loaded.config.workers.deep?.type, "pi");
  assert.equal(loaded.config.workers.deep?.model, "openai/gpt");
});

test("loadConfig rejects removed role/control fields and graph access policy", () => {
  for (const extra of [
    { profiles: {} },
    { agents: ["x"] },
    { control: {} },
    { graph: { readers: ["planner"] } },
    { task: { target: "x", goal: "g", session: "old" } },
  ]) {
    const value = "task" in extra
      ? extra
      : { task: { target: "x", goal: "g" }, ...extra };
    const { taskPath } = setup(value);
    assert.throws(() => loadConfig(taskPath), /unknown field/);
  }
});

test("loadConfig rejects predeclared federation members because Session ids are random UUIDs", () => {
  const { taskPath } = setup({
    task: { target: "x", goal: "g" },
    federation: { scope: "group", members: ["old-name"] },
  });
  assert.throws(() => loadConfig(taskPath), /unknown field "members"/);
});

test("loadConfig rejects a role bundle that references an undefined Worker", () => {
  const { taskPath } = setup({
    task: { target: "x", goal: "g" },
    agent: "custom",
    workers: { opencode: { type: "opencode" } },
  }, { roles: { explorer_deep: { role: "explorer", worker: "missing" } } });
  assert.throws(
    () => loadConfig(taskPath),
    /references missing worker/,
  );
});

test("loadConfig rejects invalid Worker and scheduler values", () => {
  for (const value of [
    { workers: { x: { type: "unknown" } } },
    { scheduler: { maxConcurrent: 0 } },
    { workers: { x: { type: "codex", timeoutMs: -1 } } },
  ]) {
    const { taskPath } = setup({ task: { target: "x", goal: "g" }, ...value });
    assert.throws(() => loadConfig(taskPath), /must be one of|positive integer/);
  }
});

test("loadConfig rejects removed API, HTTP, Provider, and backend Worker fields", () => {
  for (const worker of [
    { kind: "agent", backend: "opencode" },
    { type: "opencode", transport: "http" },
    { type: "codex", provider: "openai" },
    { type: "pi", baseUrl: "https://example.test" },
    { type: "claude-code", apiKeyEnv: "ANTHROPIC_API_KEY" },
  ]) {
    const { taskPath } = setup({
      task: { target: "x", goal: "g" },
      workers: { worker },
    });
    assert.throws(() => loadConfig(taskPath), /unknown field/);
  }
});
