import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExecute, parsePlan, parseSupervise } from "../dist/runtime/contracts.js";

test("contracts accept JSON embedded in prose or fences but reject garbage", () => {
  assert.equal(parsePlan("```json\n{\"kind\":\"noop\"}\n```", 4).kind, "noop");
  assert.equal(parseSupervise("```\n{\"kind\":\"noop\"}\n```").kind, "noop");
  assert.equal(parseExecute("```json\n{\"kind\":\"fact\",\"description\":\"x\",\"artifact\":{\"filename\":\"x.md\",\"mediaType\":\"text/markdown\",\"content\":\"x\"}}\n```").kind, "fact");
  assert.equal(parseExecute('{"kind":"fact","description":"self-contained result","artifact":null}').artifact, null);
  assert.equal(parseExecute('{"kind":"fact","description":"self-contained result","artifact":null}').artifact, null);
  assert.equal(parsePlan("I'll plan now.\n```json\n{\"kind\":\"noop\"}\n```", 4).kind, "noop");
  assert.equal(parseExecute("Reasoning...\n{\"kind\":\"fact\",\"description\":\"x\",\"artifact\":{\"filename\":\"x.md\",\"mediaType\":\"text/markdown\",\"content\":\"x\"}}\ndone").kind, "fact");
  // Reasoning models wrap output in <think> blocks whose prose may contain
  // unbalanced braces while the model reasons about the JSON shape.
  assert.equal(parseExecute("<think>I should emit { kind: fact } here</think>\n{\"kind\":\"fact\",\"description\":\"x\",\"artifact\":{\"filename\":\"x.md\",\"mediaType\":\"text/markdown\",\"content\":\"x\"}}").kind, "fact");
  assert.equal(parsePlan("<think>planning with { fake } braces</think>\n```json\n{\"kind\":\"noop\"}\n```", 4).kind, "noop");
  assert.equal(parseSupervise("<think>multi\nline\nreasoning</think>{\"kind\":\"noop\"}").kind, "noop");
  // Trailing prose after the JSON object (e.g. a markdown explanation whose own
  // text contains braces) must be ignored via brace-balanced extraction.
  assert.equal(parseSupervise('{"kind":"hint","content":"verify the evidence"}\n\n| Rationale | {why} |\n| --- | --- |').kind, "hint");
  assert.equal(parsePlan('{"kind":"noop"} Done: no new task {today}.', 4).kind, "noop");
  assert.throws(() => parseExecute("not json at all"), /one JSON object/);
});

test("contracts reject unknown, missing, and oversized Fact fields", () => {
  assert.throws(() => parsePlan('{"kind":"complete","from":[]}', 3));
  assert.throws(() => parseExecute('{"kind":"fact","description":"x","extra":1}'));
  assert.throws(() => parseExecute('{"kind":"fact","description":"x"}'), /artifact/);
  assert.throws(() => parseExecute('{"kind":"fact","description":"x","artifact":[]}'), /object/);
  assert.throws(() => parseExecute('{"kind":"fact","description":"x","artifact":[]}'), /object/);
  assert.throws(() => parseSupervise('{"kind":"hint"}'));
  assert.throws(
    () => parseExecute(JSON.stringify({ kind: "fact", description: "安".repeat(342), artifact: { filename: "x.md", mediaType: "text/markdown", content: "x" } })),
    /1 KiB/,
  );
  assert.throws(() => parseSupervise(JSON.stringify({ kind: "hint", content: "安".repeat(342) })), /1 KiB/);
  assert.equal(parsePlan(JSON.stringify({
    kind: "intents",
    intents: [{ from: [{ projectId: "project", factId: "origin", description: "origin" }], description: "安".repeat(342) }],
  }), 1).kind, "intents", "Intent descriptions may be longer than Fact descriptions");
  assert.equal(parsePlan(JSON.stringify({
    kind: "intents",
    intents: [{ from: [{ projectId: "project", factId: "origin", description: "origin" }], customProfile: "Use for research.", description: "work" }],
  }), 1, ["Use for research."]).kind, "intents");
  assert.throws(() => parsePlan(JSON.stringify({
    kind: "intents",
    intents: [{ from: [{ projectId: "project", factId: "origin", description: "origin" }], customProfile: "unknown", description: "work" }],
  }), 1, ["Use for research."]), /unknown customProfile/);
  assert.throws(() => parsePlan(JSON.stringify({
    kind: "intents",
    intents: [{ from: [{ projectId: "project", factId: "origin", description: "origin" }], description: "安".repeat(683) }],
  }), 1), /2 KiB/);
});
