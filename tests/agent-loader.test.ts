import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgent } from "../dist/config/agent-loader.js";

function bundle(value: unknown): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "peak-agent-bundle-"));
  writeFileSync(join(dir, "bundle.json"), JSON.stringify(value), "utf8");
  return { dir };
}

test("loadAgent loads one reusable role bundle and keeps native roles when omitted", () => {
  const { dir } = bundle({
    roles: {
      planner_vuln: {
        role: "planner",
        worker: "planner-worker",
        prompt: { instructions: "Plan an application vulnerability hunt." },
        tools: ["read", "grep"],
        skills: ["android-security"],
        context: { graphView: "focused", maxFacts: 120 },
      },
    },
  });
  const profiles = loadAgent("bundle", dir);
  assert.equal(profiles.planner_vuln?.role, "planner");
  assert.equal(profiles.planner_vuln?.runtime.worker, "planner-worker");
  assert.deepEqual(profiles.planner_vuln?.tools, ["read", "grep"]);
  assert.deepEqual(profiles.planner_vuln?.prompt.skills, ["android-security"]);
  assert.equal(profiles.planner_vuln?.permissions.includes("create_intent"), true);
  assert.equal(profiles.planner_vuln?.output.contract, "main_decision");
  assert.equal(profiles.explorer?.role, "explorer");
  assert.equal(profiles.evaluator?.role, "evaluator");
  assert.equal(profiles.metacog?.role, "metacog");
  assert.equal(profiles.planner, undefined, "custom planner replaces the native planner profile");
});

test("loadAgent supports multiple explorer configurations with different workers", () => {
  const { dir } = bundle({
    roles: {
      explorer_gather: { role: "explorer", worker: "fast", tools: ["grep"] },
      explorer_analysis: { role: "explorer", worker: "deep", tools: ["read", "bash"] },
    },
  });
  const profiles = loadAgent("bundle", dir);
  assert.equal(profiles.explorer, undefined);
  assert.equal(profiles.explorer_gather?.runtime.worker, "fast");
  assert.equal(profiles.explorer_analysis?.runtime.worker, "deep");
});

test("loadAgent rejects old single-slot files and permission/output overrides", () => {
  for (const value of [
    { slot: "explorer", runtime: { worker: "x" } },
    { roles: { x: { role: "explorer", permissions: ["get_graph"] } } },
    { roles: { x: { role: "explorer", output: { contract: "hints" } } } },
  ]) {
    const { dir } = bundle(value);
    assert.throws(() => loadAgent("bundle", dir), /unknown field|roles/);
  }
});

test("loadAgent rejects missing files, paths, and custom ids without a role", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-agent-bundle-"));
  assert.throws(() => loadAgent("missing", dir), /not found/);
  assert.throws(() => loadAgent("..\/outside", dir), /must not contain a path/);
  writeFileSync(join(dir, "bundle.json"), JSON.stringify({ roles: { custom: { worker: "x" } } }));
  assert.throws(() => loadAgent("bundle", dir), /must declare role/);
});

test("loadAgent rejects malformed prompt, context, tools, and execution fields", () => {
  for (const role of [
    { role: "explorer", prompt: { unknown: "x" } },
    { role: "explorer", context: { graphView: "everything" } },
    { role: "explorer", tools: "read" },
    { role: "explorer", maxActive: 0 },
  ]) {
    const { dir } = bundle({ roles: { custom: role } });
    assert.throws(() => loadAgent("bundle", dir), /unknown field|must be one of|array|greater than zero/);
  }
});

test("loadAgent accepts Skill names and rejects Skill paths", () => {
  const { dir } = bundle({ roles: { explorer: { skills: ["decx-cli", "app-vulnhunt"] } } });
  assert.deepEqual(loadAgent("bundle", dir).explorer?.prompt.skills, ["decx-cli", "app-vulnhunt"]);

  for (const skill of ["../skill", "skills/local", "local\\skill", "SKILL.md", "UpperCase"]) {
    const item = bundle({ roles: { explorer: { skills: [skill] } } });
    assert.throws(() => loadAgent("bundle", item.dir), /skill name/);
  }
});
