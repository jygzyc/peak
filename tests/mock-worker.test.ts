import { test } from "node:test";
import { strict as assert } from "node:assert";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { parseEnvelope } from "../dist/agent/parse-envelope.js";

test("registerDefaults: planner prompt yields a decisions envelope with one intent", async () => {
  const worker = new MockWorker().registerDefaults();
  const result = await worker.execute({
    prompt: "You are an automated planning module. ... context ...",
    config: { type: "opencode" },
  });
  assert.equal(result.returncode, 0);
  const env = parseEnvelope(result.text, "test");
  assert.equal(env.kind, "decisions");
  assert.equal(env.data.createIntents.length, 1);
  assert.ok(env.data.createIntents[0].description.includes("MOCK-INTENT"));
  assert.equal(env.data.concludeRun, null);
});

test("registerDefaults: explorer prompt yields a candidate fact envelope", async () => {
  const worker = new MockWorker().registerDefaults();
  const result = await worker.execute({
    prompt: "# Explorer Role (Subagent)\n\ninvestigate the intent below",
    config: { type: "opencode" },
  });
  assert.equal(result.returncode, 0);
  const env = parseEnvelope(result.text, "test");
  assert.equal(env.kind, "fact");
  assert.equal(env.data.description.includes("MOCK FACT"), true);
  assert.equal(env.data.confidence, 0.9);
});

test("registerDefaults: evaluator prompt yields an accept verdict", async () => {
  const worker = new MockWorker().registerDefaults();
  const result = await worker.execute({
    prompt: "# Evaluator Role\n\nassess the candidate fact",
    config: { type: "opencode" },
  });
  assert.equal(result.returncode, 0);
  const env = parseEnvelope(result.text, "test");
  assert.equal(env.kind, "verdict");
  assert.equal(env.data.decision, "pass");
});

test("registerDefaults: second planner call concludes the run (natural termination)", async () => {
  const worker = new MockWorker().registerDefaults();
  await worker.execute({ prompt: "automated planning module", config: { type: "opencode" } });
  const second = await worker.execute({
    prompt: "You are an automated planning module. (re-invoked)",
    config: { type: "opencode" },
  });
  const env = parseEnvelope(second.text, "test");
  assert.equal(env.kind, "decisions");
  assert.equal(env.data.createIntents.length, 0);
  assert.ok(env.data.concludeRun);
});

test("registerDefaults: unmatched prompt still falls through to failure", async () => {
  const worker = new MockWorker().registerDefaults();
  const result = await worker.execute({ prompt: "completely unrelated prompt", config: { type: "opencode" } });
  assert.equal(result.returncode, 1);
  assert.match(result.stderr ?? "", /no mock match/);
});
