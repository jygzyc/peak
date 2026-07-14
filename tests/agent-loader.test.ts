import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent, applyAgentPatch, injectAgents, type AgentFile } from "../dist/config/agent-loader.js";
import { defaultConfig } from "../dist/config/default-config.js";
import type { SubagentProfile } from "../dist/agent/types.js";

/**
 * Agent loader tests — verifies the deep-merge injection model: an agent file is
 * a PATCH over a builtin profile slot, overriding declared fields and keeping
 * builtin defaults for the rest.
 */

function withAgents<T>(files: Record<string, AgentFile>, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "peak-agents-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(content));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const baseExplorer: SubagentProfile = defaultConfig().profiles.explorer;

test("loadAgent: reads and validates an agent file", () => {
  withAgents({ foo: { slot: "explorer", runtime: { worker: "codex" } } }, (dir) => {
    const a = loadAgent("foo", { agentsDir: dir });
    assert.equal(a.name, "foo");
    assert.equal(a.slot, "explorer");
    assert.equal(a.file.runtime?.worker, "codex");
  });
});

test("loadAgent: throws on missing file", () => {
  withAgents({}, (dir) => {
    assert.throws(() => loadAgent("nope", { agentsDir: dir }), /agent config not found/);
  });
});

test("loadAgent: throws on invalid slot", () => {
  withAgents({ bad: { slot: "not-a-slot" } }, (dir) => {
    assert.throws(() => loadAgent("bad", { agentsDir: dir }), /invalid slot/);
  });
});

test("loadAgent: throws when slot missing", () => {
  withAgents({ bad: { runtime: { worker: "codex" } } as AgentFile }, (dir) => {
    assert.throws(() => loadAgent("bad", { agentsDir: dir }), /slot/);
  });
});

test("applyAgentPatch: declared fields override, omitted fields keep builtin", () => {
  const agent: AgentFile = {
    slot: "explorer",
    runtime: { worker: "codex", model: "gpt-5.5" },
    context: { graphView: "focused", maxFacts: 30 },
  };
  const merged = applyAgentPatch(baseExplorer, agent);
  // overridden
  assert.equal(merged.runtime.worker, "codex");
  assert.equal(merged.runtime.model, "gpt-5.5");
  assert.equal(merged.context.graphView, "focused");
  assert.equal(merged.context.maxFacts, 30);
  // preserved builtin (prompt, permissions, output contract)
  assert.equal(merged.prompt.file, baseExplorer.prompt.file);
  assert.deepEqual(merged.permissions, baseExplorer.permissions);
  assert.equal(merged.output.contract, baseExplorer.output.contract);
});

test("applyAgentPatch: permissions are replaced wholesale when declared", () => {
  const agent: AgentFile = { slot: "explorer", permissions: ["write_hint"] };
  const merged = applyAgentPatch(baseExplorer, agent);
  assert.deepEqual(merged.permissions, ["write_hint"], "permissions replaced, not concatenated");
});

test("applyAgentPatch: metacog triggers attach to the metacog slot", () => {
  const baseMetacog = defaultConfig().profiles.metacog!;
  const agent: AgentFile = { slot: "metacog", triggers: { everySteps: 10, everySeconds: 60 } };
  const merged = applyAgentPatch(baseMetacog, agent);
  assert.equal(merged.triggers?.everySteps, 10);
  assert.equal(merged.triggers?.everySeconds, 60);
  // base triggers replaced wholesale (declared object wins)
  assert.equal(merged.triggers?.stagnationLevel, undefined);
});

test("injectAgents: patches the declared slot and collects workers", () => {
  withAgents(
    {
      "android-source-finder": {
        slot: "explorer",
        runtime: { worker: "codex" },
        context: { graphView: "focused" },
        workers: { codex: { kind: "agent", backend: "codex", model: "o4-mini" } },
      },
    },
    (dir) => {
      const base = defaultConfig();
      const { profiles, workers } = injectAgents(base.profiles, ["android-source-finder"], { agentsDir: dir });
      assert.equal(profiles.explorer.runtime.worker, "codex");
      assert.equal(profiles.explorer.context.graphView, "focused");
      // planner/evaluator untouched
      assert.equal(profiles.planner.runtime.worker, base.profiles.planner.runtime.worker);
      // worker collected
      assert.equal(workers.codex.backend, "codex");
      assert.equal(workers.codex.model, "o4-mini");
    },
  );
});

test("injectAgents: multiple agents can target different slots", () => {
  withAgents(
    {
      "strict-reviewer": { slot: "evaluator", context: { graphView: "full" } },
      "deep-planner": { slot: "planner", cooldownSteps: 1 },
    },
    (dir) => {
      const base = defaultConfig();
      const { profiles } = injectAgents(base.profiles, ["strict-reviewer", "deep-planner"], { agentsDir: dir });
      assert.equal(profiles.evaluator.context.graphView, "full");
      assert.equal(profiles.planner.cooldownSteps, 1);
    },
  );
});
