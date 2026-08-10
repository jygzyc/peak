import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FederationBus, type PathReference } from "../dist/graph/federation-bus.js";

function pathRef(projectId: string, leafId: string, chain: string[] = [leafId]): PathReference {
  return {
    projectId,
    leaf: { projectId, id: leafId, description: leafId },
    pathAbs: `artifacts/path_abs_${leafId}`,
    segments: [chain.map((id) => ({ projectId, id, description: id }))],
  };
}

test("FederationBus delivers unscoped Board path references", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-board-fed-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  try {
    const bus = new FederationBus();
    bus.register("a", a);
    bus.register("b", b);
    const ref = pathRef("a", "f0001", ["origin", "f0001"]);
    bus.publishPath(ref);
    assert.deepEqual(bus.pendingPathsFor("b"), [ref]);
    const event = JSON.parse(readFileSync(join(a, "logs", "main.log"), "utf8").trim()) as { type: string; at: string };
    assert.equal(event.type, "send_path_reference");
    assert.match(event.at, /^\d{8}T\d{6}\.\d{3}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FederationBus retires stale Paths whose leaf became an interior node, across recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-fed-leaves-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  try {
    const first = new FederationBus();
    first.register("a", a);
    first.register("b", b);
    first.publishPath(pathRef("a", "f0001", ["origin", "f0001"]));
    // f0001 is consumed by a newer concluded Intent: its Path is interior to f0002's and retires.
    first.publishPath(pathRef("a", "f0002", ["origin", "f0001", "f0002"]));
    assert.deepEqual(first.pendingPathsFor("b").map((ref) => ref.leaf.id), ["f0002"]);

    const recovered = new FederationBus();
    recovered.register("a", a);
    recovered.register("b", b);
    assert.deepEqual(recovered.pendingPathsFor("b").map((ref) => ref.leaf.id), ["f0002"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FederationBus recovers pending and handled path references from main.log", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-fed-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  try {
    const first = new FederationBus();
    first.register("a", a, "scope");
    first.register("b", b, "scope");
    first.publishPath(pathRef("a", "f0001"));
    assert.equal(first.pendingPathsFor("b").length, 1);

    const recovered = new FederationBus();
    recovered.register("a", a, "scope");
    recovered.register("b", b, "scope");
    assert.equal(recovered.pendingPathsFor("b").length, 1);
    recovered.markPathsHandled("b", recovered.pendingPathsFor("b"));

    const final = new FederationBus();
    final.register("a", a, "scope");
    final.register("b", b, "scope");
    assert.equal(final.pendingPathsFor("b").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FederationBus isolates Federation scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-fed-scope-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  try {
    const bus = new FederationBus();
    bus.register("a", a, "one");
    bus.register("b", b, "two");
    bus.publishPath(pathRef("a", "f0001"));
    assert.equal(bus.pendingPathsFor("b").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FederationBus ignores legacy fact-reference log events", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-fed-legacy-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(join(a, "logs"), { recursive: true });
  mkdirSync(b);
  try {
    writeFileSync(join(a, "logs", "main.log"), [
      JSON.stringify({ type: "send_fact_reference", targetProjectId: "b", projectId: "a", id: "f0001", description: "legacy" }),
      JSON.stringify({ type: "receive_fact_reference", projectId: "a", id: "f0002", description: "legacy" }),
      "",
    ].join("\n"));
    const bus = new FederationBus();
    bus.register("a", a);
    bus.register("b", b);
    assert.equal(bus.pendingPathsFor("b").length, 0);
    assert.equal(bus.pendingPathsFor("a").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
