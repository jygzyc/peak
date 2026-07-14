import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config/task-config.js";
import { defaultConfig } from "../dist/config/default-config.js";
import { DEFAULT_METACOG_TRIGGERS } from "../dist/agent/types.js";
import { agentsDir, configFile } from "../dist/config/peak-home.js";

test("loadConfig: reads minimal task.json with target + goal", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  const cfg = {
    task: { target: "app.apk", goal: "find vulns" },
  };
  writeFileSync(join(dir, "task.json"), JSON.stringify(cfg));

  const { config, session } = loadConfig(join(dir, "task.json"));
  assert.equal(config.task.target, "app.apk");
  assert.equal(config.task.goal, "find vulns");
  assert.ok(session);
  assert.equal(config.profiles.planner.runtime.worker, "opencode");
});

test("loadConfig: overrides workers and scheduler", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  const cfg = {
    task: { target: "T", goal: "G" },
    workers: {
      opencode: { kind: "agent", backend: "opencode", model: "claude-sonnet-4" },
    },
    scheduler: {
      maxConcurrent: 5,
      refillPerTick: 2,
    },
  };
  writeFileSync(join(dir, "task.json"), JSON.stringify(cfg));

  const { config } = loadConfig(join(dir, "task.json"));
  assert.equal(config.scheduler!.maxConcurrent, 5);
  assert.equal(config.scheduler!.refillPerTick, 2);
  assert.equal(config.workers.opencode.model, "claude-sonnet-4");
});

test("loadConfig: legacy workflow.limits maps to scheduler (backward compat)", () => {
  // Old task.json files used workflow.limits for scheduler knobs. The loader
  // maps maxConcurrent/refillPerTick/workerLeaseMs forward; maxSteps/stopGate/
  // maxStagnation are ignored (no depth limit, natural termination).
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  const cfg = {
    task: { target: "T", goal: "G" },
    workflow: { limits: { maxSteps: 500, maxConcurrent: 5, refillPerTick: 2 } },
  };
  writeFileSync(join(dir, "task.json"), JSON.stringify(cfg));

  const { config } = loadConfig(join(dir, "task.json"));
  assert.equal(config.scheduler!.maxConcurrent, 5, "legacy maxConcurrent maps to scheduler");
  assert.equal(config.scheduler!.refillPerTick, 2, "legacy refillPerTick maps to scheduler");
});

test("loadConfig: explorer can declare a worker pool", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  const cfg = {
    task: { target: "T", goal: "G" },
    profiles: {
      explorer: { runtime: { worker: "codex", workers: ["codex", "claude-code"] }, prompt: { file: "explorer.md" } },
    },
    workers: {
      codex: { kind: "agent", backend: "codex" },
      "claude-code": { kind: "agent", backend: "claude-code" },
    },
  };
  writeFileSync(join(dir, "task.json"), JSON.stringify(cfg));

  const { config } = loadConfig(join(dir, "task.json"));
  assert.deepEqual(config.profiles.explorer.runtime.workers, ["codex", "claude-code"]);
});

test("loadConfig: non-array agents field is ignored (legacy object shape no longer throws)", () => {
  // `agents` as an ARRAY is the new injection feature. A legacy OBJECT-shaped
  // `agents` (the old removed field) is now silently ignored rather than
  // rejected, so old configs that happened to use the key won't hard-fail.
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({
    task: { target: "T", goal: "G" },
    agents: { explorer: { worker: "opencode" } },
  }));
  const { config } = loadConfig(join(dir, "task.json"));
  assert.equal(config.task.target, "T");
  // builtin profiles are untouched (object agents ignored, not injected)
  assert.equal(config.profiles.explorer.runtime.worker, "opencode");
});


test("loadConfig: throws on missing target", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({ task: { goal: "G" } }));
  assert.throws(() => loadConfig(join(dir, "task.json")), /target/);
});

test("loadConfig: throws on missing goal", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({ task: { target: "T" } }));
  assert.throws(() => loadConfig(join(dir, "task.json")), /goal/);
});

test("loadConfig: throws on nonexistent file", () => {
  assert.throws(() => loadConfig("/nonexistent/task.json"), /not found/);
});

test("loadConfig: session override works", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({ task: { target: "T", goal: "G" } }));
  const { session } = loadConfig(join(dir, "task.json"), "custom-session");
  assert.equal(session, "custom-session");
});

test("defaultConfig: returns valid config with opencode as default worker", () => {
  const config = defaultConfig();
  assert.equal(config.profiles.planner.runtime.worker, "opencode");
  assert.equal(config.profiles.explorer.runtime.worker, "opencode");
  assert.equal(config.profiles.evaluator.runtime.worker, "opencode");
  assert.ok(config.profiles.planner.prompt.file);
  assert.ok(config.profiles.explorer.prompt.file);
  assert.ok(config.profiles.evaluator.prompt.file);
  assert.ok(config.workers.opencode);
  assert.equal(config.workers.opencode.kind, "agent");
});

test("metacog everySeconds default is consistent across all sources", () => {
  // DEFAULT_METACOG_TRIGGERS, the metacog profile's triggers, and
  // control.metacogIntervalSeconds must all agree on the wall-clock metacog
  // interval. Triggers now live on the metacog profile (per-agent), not a
  // global workflow block.
  const config = defaultConfig();
  assert.equal(DEFAULT_METACOG_TRIGGERS.everySeconds, 30);
  assert.equal(config.profiles.metacog?.triggers?.everySeconds, 30);
  assert.equal(config.control?.metacogIntervalSeconds, 30);
});

test("loadConfig: agents array injects ~/.peak/agents/ configs into builtin slots", () => {
  // The new `agents` field references reusable role configs by name; each is
  // injected as a patch over its declared builtin slot. Here an agent overrides
  // explorer's worker/context and brings its own worker definition.
  const home = mkdtempSync(join(tmpdir(), "peak-home-"));
  const prevHome = process.env.PEAK_HOME;
  process.env.PEAK_HOME = home;
  try {
    mkdirSync(agentsDir(), { recursive: true });
    writeFileSync(join(agentsDir(), "android-source-finder.json"), JSON.stringify({
      slot: "explorer",
      runtime: { worker: "codex" },
      context: { graphView: "focused", maxFacts: 30 },
      workers: { codex: { kind: "agent", backend: "codex", model: "o4-mini" } },
    }));

    const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
    writeFileSync(join(dir, "task.json"), JSON.stringify({
      task: { target: "app.apk", goal: "find vulns" },
      agents: ["android-source-finder"],
    }));

    const { config } = loadConfig(join(dir, "task.json"));
    assert.equal(config.profiles.explorer.runtime.worker, "codex", "agent patched explorer's worker");
    assert.equal(config.profiles.explorer.context.maxFacts, 30);
    assert.ok(config.workers.codex, "agent-provided worker merged in");
    assert.equal(config.workers.codex.model, "o4-mini");
    // planner untouched
    assert.notEqual(config.profiles.planner.runtime.worker, "codex");
  } finally {
    if (prevHome === undefined) delete process.env.PEAK_HOME;
    else process.env.PEAK_HOME = prevHome;
  }
});

test("loadConfig: task workers override agent-provided workers on conflict", () => {
  const home = mkdtempSync(join(tmpdir(), "peak-home-"));
  const prevHome = process.env.PEAK_HOME;
  process.env.PEAK_HOME = home;
  try {
    mkdirSync(agentsDir(), { recursive: true });
    writeFileSync(join(agentsDir(), "codex-explorer.json"), JSON.stringify({
      slot: "explorer",
      runtime: { worker: "codex" },
      workers: { codex: { kind: "agent", backend: "codex", model: "agent-default" } },
    }));

    const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
    writeFileSync(join(dir, "task.json"), JSON.stringify({
      task: { target: "T", goal: "G" },
      agents: ["codex-explorer"],
      workers: { codex: { kind: "agent", backend: "codex", model: "task-wins" } },
    }));

    const { config } = loadConfig(join(dir, "task.json"));
    assert.equal(config.workers.codex.model, "task-wins", "task-level worker overrides agent-provided");
  } finally {
    if (prevHome === undefined) delete process.env.PEAK_HOME;
    else process.env.PEAK_HOME = prevHome;
  }
});

test("loadConfig: session derived from task.target when not explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({
    task: { target: "app.apk", goal: "G" },
  }));
  const { session } = loadConfig(join(dir, "task.json"));
  assert.equal(session, "app", "session derived from target basename (stem)");
});

test("loadConfig: explicit task.session wins over target-derived", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({
    task: { target: "app.apk", goal: "G", session: "custom-session" },
  }));
  const { session } = loadConfig(join(dir, "task.json"));
  assert.equal(session, "custom-session");
});

test("loadConfig: merges ~/.peak/config.json baseline workers", () => {
  const home = mkdtempSync(join(tmpdir(), "peak-home-"));
  const prevHome = process.env.PEAK_HOME;
  process.env.PEAK_HOME = home;
  try {
    writeFileSync(configFile(), JSON.stringify({
      workers: { codex: { kind: "agent", backend: "codex" } },
    }));

    const dir = mkdtempSync(join(tmpdir(), "peak-cfg-"));
    writeFileSync(join(dir, "task.json"), JSON.stringify({
      task: { target: "T", goal: "G" },
    }));

    const { config } = loadConfig(join(dir, "task.json"));
    assert.ok(config.workers.codex, "baseline worker from config.json merged in");
    assert.equal(config.workers.codex.backend, "codex");
    // default worker still present
    assert.ok(config.workers.opencode);
  } finally {
    if (prevHome === undefined) delete process.env.PEAK_HOME;
    else process.env.PEAK_HOME = prevHome;
  }
});
