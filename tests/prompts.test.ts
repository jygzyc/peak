import { test } from "node:test";
import { strict as assert } from "node:assert";
import { outputContractInstructions } from "../dist/agent/contracts.js";
import { BUILTIN_SYSTEM_PROMPTS } from "../dist/agent/prompts/index.js";

test("builtin prompts: exactly one responsibility prompt per protocol role", () => {
  assert.deepEqual(Object.keys(BUILTIN_SYSTEM_PROMPTS), [
    "planner", "explorer", "evaluator", "metacog",
  ]);
  for (const [role, prompt] of Object.entries(BUILTIN_SYSTEM_PROMPTS)) {
    assert.match(prompt, new RegExp(`# ${role[0]!.toUpperCase()}${role.slice(1)} Role`));
    assert.match(prompt, /## Boundaries/);
    assert.doesNotMatch(prompt, /```json/);
  }
});

test("output contracts: runtime construction supplies every validated envelope", () => {
  const mainDecision = outputContractInstructions("main_decision");
  assert.match(mainDecision, /"kind": "decisions"/);
  assert.match(mainDecision, /replace concludeRun: null/);
  assert.match(mainDecision, /"from": \["f001"\]/);
  assert.match(outputContractInstructions("candidate_fact"), /"kind": "fact"/);
  assert.match(outputContractInstructions("verdict"), /pass \| deny \| pending/);
  assert.match(outputContractInstructions("broadcast_assessment"), /condition_satisfied/);
  assert.match(outputContractInstructions("hints"), /"kind": "hints"[\s\S]*"kind": "stop"/);
  assert.match(outputContractInstructions("stop"), /"kind": "stop"/);
});
