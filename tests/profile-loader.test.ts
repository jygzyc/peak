import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptLoader, resolvePromptPaths } from "../dist/config/prompt-loader.js";
import { normalizeProfile } from "../dist/config/profile-loader.js";

test("PromptLoader: loads prompt.file from disk relative to baseDir", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-pl-"));
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "prompts", "role.md"), "# Custom Role\nYou are a source finder.");

  const loader = new PromptLoader({ baseDir: dir });
  const resolved = loader.load({ file: "prompts/role.md" });
  assert.equal(resolved.fromConfig, true);
  assert.match(resolved.preamble, /Custom Role/);
  assert.match(resolved.manifest.hash, /^[a-f0-9]{64}$/);
  assert.equal(resolved.manifest.components[0]!.kind, "primary");
  assert.equal(resolved.manifest.components[0]!.resolvedPath, join(dir, "prompts", "role.md"));
});

test("PromptLoader: loads builtin system prompt from TypeScript registry", () => {
  const resolved = new PromptLoader().load({ file: "builtin:planner" });
  assert.equal(resolved.fromConfig, true);
  assert.match(resolved.preamble, /automated planning module/i);
  assert.equal(resolved.manifest.components[0]!.source, "builtin:planner");
  assert.equal(resolved.manifest.components[0]!.resolvedPath, undefined);
});

test("resolvePromptPaths: preserves builtin sources", () => {
  const resolved = resolvePromptPaths({
    file: "builtin:explorer",
    concludeFile: "builtin:explorer-conclude",
  }, "C:/task");
  assert.equal(resolved.file, "builtin:explorer");
  assert.equal(resolved.concludeFile, "builtin:explorer-conclude");
});

test("PromptLoader: returns fromConfig=false when file not found", () => {
  const loader = new PromptLoader({ baseDir: "/nonexistent" });
  const resolved = loader.load({ file: "missing.md" });
  assert.equal(resolved.fromConfig, false);
  assert.equal(resolved.preamble, "");
  assert.equal(resolved.manifest.components.length, 0);
});

test("PromptLoader: appends rules files after primary", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-pl-"));
  writeFileSync(join(dir, "role.md"), "# Role");
  writeFileSync(join(dir, "rule.md"), "RULE: be strict.");

  const loader = new PromptLoader({ baseDir: dir });
  const resolved = loader.load({ file: "role.md", rules: ["rule.md"] });
  assert.match(resolved.preamble, /# Role/);
  assert.match(resolved.preamble, /RULE: be strict/);
  assert.deepEqual(resolved.manifest.components.map((item) => item.kind), ["primary", "rule"]);
});

test("PromptLoader: skills are typed, hashed manifest components", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-pl-"));
  writeFileSync(join(dir, "role.md"), "# Role");
  writeFileSync(join(dir, "skill.md"), "# Skill\nTrace attacker-controlled values to sinks.");

  const resolved = new PromptLoader({ baseDir: dir }).load({
    file: "role.md",
    skills: ["skill.md"],
  });

  assert.match(resolved.preamble, /Trace attacker-controlled values/);
  assert.deepEqual(resolved.manifest.components.map((item) => item.kind), ["primary", "skill"]);
  assert.match(resolved.manifest.components[1]!.sha256, /^[a-f0-9]{64}$/);
});

test("PromptLoader: hashes normalized content consistently across line endings", () => {
  const a = mkdtempSync(join(tmpdir(), "peak-pl-a-"));
  const b = mkdtempSync(join(tmpdir(), "peak-pl-b-"));
  writeFileSync(join(a, "role.md"), "# Role\r\nLine two\r\n");
  writeFileSync(join(b, "role.md"), "# Role\nLine two\n");
  const first = new PromptLoader({ baseDir: a }).load({ file: "role.md" });
  const second = new PromptLoader({ baseDir: b }).load({ file: "role.md" });
  assert.equal(first.manifest.hash, second.manifest.hash);
  assert.equal(first.preamble, second.preamble);
});

test("PromptLoader: missing path-like rule fails instead of injecting its filename", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-pl-"));
  writeFileSync(join(dir, "role.md"), "# Role");
  const loader = new PromptLoader({ baseDir: dir });
  assert.throws(
    () => loader.load({ file: "role.md", rules: ["rules/missing.md"] }),
    /prompt rule file not found/,
  );
});

test("profile-loader: normalizeProfile accepts full structured shape", () => {
  const p = normalizeProfile("source-finder", {
    role: "explorer",
    runtime: { worker: "codex", model: "gpt-5.5" },
    prompt: { file: "prompts/source-finder.md", skills: ["skills/trace.md"] },
    context: { graphView: "focused", maxFacts: 30 },
    output: { contract: "candidate_fact" },
    maxActive: 2,
  });
  assert.equal(p.role, "explorer");
  assert.equal(p.runtime.model, "gpt-5.5");
  assert.equal(p.context.graphView, "focused");
  assert.equal(p.context.maxFacts, 30);
  assert.equal(p.output.contract, "candidate_fact");
  assert.equal(p.maxActive, 2);
  assert.equal(p.prompt.file, "prompts/source-finder.md");
  assert.deepEqual(p.prompt.skills, ["skills/trace.md"]);
});

test("profile-loader: throws when runtime.worker missing", () => {
  assert.throws(() => normalizeProfile("x", { role: "explorer", prompt: { file: "x.md" } }), /runtime\.worker/);
});

test("profile-loader: rejects runtime fields outside the runtime object", () => {
  assert.throws(() => normalizeProfile("x", {
    role: "explorer",
    worker: "opencode",
    prompt: { file: "x.md" },
  }), /unknown field "worker"/);
});

test("profile-loader: throws when prompt.file missing", () => {
  assert.throws(() => normalizeProfile("x", { role: "explorer", runtime: { worker: "opencode" } }), /prompt\.file/);
});

test("profile-loader: defaults graphView to full when context omitted", () => {
  const p = normalizeProfile("x", {
    role: "explorer",
    runtime: { worker: "opencode" },
    prompt: { file: "x.md" },
  });
  assert.equal(p.context.graphView, "full");
});

test("profile-loader: fills builtin permissions for planner role", () => {
  const p = normalizeProfile("planner", {
    role: "planner",
    runtime: { worker: "opencode" },
    prompt: { file: "planner.md" },
  });
  assert.ok(p.permissions.includes("create_intent"));
  assert.ok(p.permissions.includes("create_end_fact"));
});

test("profile-loader: fills builtin permissions for explorer role", () => {
  const p = normalizeProfile("explorer", {
    role: "explorer",
    runtime: { worker: "opencode" },
    prompt: { file: "explorer.md" },
  });
  assert.ok(p.permissions.includes("write_candidate_fact"));
});

test("profile-loader: custom profile id binds to a protocol role and may narrow permissions", () => {
  const p = normalizeProfile("source-finder", {
    role: "explorer",
    runtime: { worker: "codex" },
    prompt: { file: "source-finder.md" },
    permissions: ["handle_intent", "write_candidate_fact"],
  });
  assert.equal(p.role, "explorer");
  assert.deepEqual(p.permissions, ["handle_intent", "write_candidate_fact"]);
});

test("profile-loader: role permissions cannot be expanded", () => {
  assert.throws(() => normalizeProfile("source-finder", {
    role: "explorer",
    runtime: { worker: "codex" },
    prompt: { file: "source-finder.md" },
    permissions: ["write_candidate_fact", "change_fact"],
  }), /cannot declare permissions: change_fact/);
});

test("profile-loader: custom permissions with a builtin role override the builtin set", () => {
  // An explicit permissions array may narrow a builtin role's capabilities.
  const p = normalizeProfile("x", {
    role: "explorer",
    runtime: { worker: "opencode" },
    prompt: { file: "x.md" },
    permissions: ["handle_intent"],
  });
  assert.deepEqual(p.permissions, ["handle_intent"]);
});

test("profile-loader: rejects non-array permissions", () => {
  assert.throws(() => normalizeProfile("x", {
    role: "explorer",
    runtime: { worker: "opencode" },
    prompt: { file: "x.md" },
    permissions: "write_candidate_fact",
  }), /permissions must be an array/);
});

test("profile-loader: rejects invalid permission entries", () => {
  assert.throws(() => normalizeProfile("x", {
    role: "explorer",
    runtime: { worker: "opencode" },
    prompt: { file: "x.md" },
    permissions: ["write_candidate_fact", "not_a_real_permission", 123, null],
  }), /invalid permissions/);
});

test("profile-loader: arbitrary protocol role is rejected", () => {
  assert.throws(() => normalizeProfile("x", {
    role: "totally-custom",
    runtime: { worker: "opencode" },
    prompt: { file: "x.md" },
  }), /must bind role to planner\|explorer\|evaluator\|metacog/);
});

test("profile-loader: retry policy is normalized and validated", () => {
  const profile = normalizeProfile("retrying", {
    role: "explorer",
    runtime: { worker: "opencode" },
    prompt: { file: "x.md" },
    retry: { maxAttempts: 5, backoffMs: 250 },
  });
  assert.deepEqual(profile.retry, { maxAttempts: 5, backoffMs: 250 });
  assert.throws(() => normalizeProfile("bad-retry", {
    role: "explorer",
    runtime: { worker: "opencode" },
    prompt: { file: "x.md" },
    retry: { maxAttempts: 0 },
  }), /positive integer/);
});

test("profile-loader: rejects removed first-version fields", () => {
  const planner = {
    role: "planner",
    runtime: { worker: "opencode" },
    prompt: { file: "x.md" },
  };
  assert.throws(
    () => normalizeProfile("planner", { ...planner, sessionReuse: true }),
    /unknown field "sessionReuse"/,
  );
  assert.throws(
    () => normalizeProfile("planner", {
      ...planner,
      context: { graphView: "full", rotateOnContextFull: true },
    }),
    /unknown field "rotateOnContextFull"/,
  );
});
