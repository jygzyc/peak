import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FederationBus } from "../dist/graph/federation-bus.js";

test("FederationBus recovers pending and handled references from main.log", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-fed-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  try {
    const first = new FederationBus();
    first.register("a", a, "scope");
    first.register("b", b, "scope");
    first.publish({ projectId: "a", factId: "f001" }, "proof");
    assert.equal(first.pendingFor("b").length, 1);

    const recovered = new FederationBus();
    recovered.register("a", a, "scope");
    recovered.register("b", b, "scope");
    assert.equal(recovered.pendingFor("b").length, 1);
    recovered.markHandled("b", recovered.pendingFor("b"));

    const final = new FederationBus();
    final.register("a", a, "scope");
    final.register("b", b, "scope");
    assert.equal(final.pendingFor("b").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
