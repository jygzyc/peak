import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FederationBus } from "../dist/graph/federation-bus.js";

test("FederationBus delivers unscoped Board references", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-board-fed-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  try {
    const bus = new FederationBus();
    bus.register("a", a);
    bus.register("b", b);
    bus.publish({ projectId: "a", factId: "f001", description: "shared Board evidence" });
    assert.deepEqual(bus.pendingFor("b"), [
      { projectId: "a", factId: "f001", description: "shared Board evidence" },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FederationBus keeps only the current broadcast leaf frontier across recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-fed-leaves-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  try {
    const first = new FederationBus();
    first.register("a", a);
    first.register("b", b);
    first.publish({ projectId: "a", factId: "f001", description: "first" });
    first.publish(
      { projectId: "a", factId: "f002", description: "later" },
      [{ projectId: "a", factId: "f001", description: "first" }],
    );
    assert.deepEqual(first.pendingFor("b").map((ref) => ref.factId), ["f002"]);

    const recovered = new FederationBus();
    recovered.register("a", a);
    recovered.register("b", b);
    assert.deepEqual(recovered.pendingFor("b").map((ref) => ref.factId), ["f002"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FederationBus recovers pending and handled references from main.log", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-fed-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  try {
    const first = new FederationBus();
    first.register("a", a, "scope");
    first.register("b", b, "scope");
    first.publish({ projectId: "a", factId: "f001", description: "proof" });
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
