import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExecute, parsePlan, parseSupervise } from "../dist/runtime/contracts.js";

test("contracts accept JSON embedded in prose or fences but reject garbage", () => {
  assert.equal(parsePlan("```json\n{\"kind\":\"noop\"}\n```", 4).kind, "noop");
  assert.equal(parseSupervise("```\n{\"kind\":\"noop\"}\n```").kind, "noop");
  assert.equal(parseExecute("```json\n{\"kind\":\"fact\",\"description\":\"x\"}\n```").kind, "fact");
  assert.equal(parsePlan("I'll plan now.\n```json\n{\"kind\":\"noop\"}\n```", 4).kind, "noop");
  assert.equal(parseExecute("Reasoning...\n{\"kind\":\"fact\",\"description\":\"x\"}\ndone").kind, "fact");
  assert.throws(() => parseExecute("not json at all"), /one JSON object/);
});

test("contracts reject unknown and missing fields", () => {
  assert.throws(() => parsePlan('{"kind":"complete","from":[]}', 3));
  assert.throws(() => parseExecute('{"kind":"fact","description":"x","extra":1}'));
  assert.throws(() => parseSupervise('{"kind":"hint"}'));
});
