import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PiWorker } from "../dist/worker/backends/pi.js";

const worker = new PiWorker();

test("PiWorker: builds JSON-mode CLI command with model and stdin", () => {
  const built = worker.buildArgv({ type: "pi", model: "anthropic/claude-sonnet" }, "prompt");
  assert.deepEqual(built.argv.slice(0, 5), ["pi", "--mode", "json", "--model", "anthropic/claude-sonnet"]);
  assert.equal(built.argv.at(-1), "-p");
  assert.equal(built.input, "prompt");
});

test("PiWorker: parses JSON events", () => {
  const output = [
    JSON.stringify({ type: "session", id: "session-42" }),
    JSON.stringify({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "result" }] },
    }),
  ].join("\n");
  assert.equal(worker.extractResponseText(output), "result");
});
