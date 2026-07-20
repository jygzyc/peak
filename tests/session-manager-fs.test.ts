import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "../dist/session/session-manager.js";

test("SessionManager creates a random UUID directory and writes .session.yaml", () => {
  const base = mkdtempSync(join(tmpdir(), "peak-sessions-"));
  const manager = new SessionManager(base);
  const selected = manager.create("application audit");
  assert.match(selected.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(existsSync(join(base, selected.id, "logs")), true);
  assert.deepEqual(manager.active(), selected);
  const yaml = readFileSync(join(base, ".session.yaml"), "utf8");
  assert.match(yaml, /name: "application audit"/);
  assert.match(yaml, new RegExp(`id: ${selected.id}`));
});

test("SessionManager rejects names as directory ids and all traversal paths", () => {
  const base = mkdtempSync(join(tmpdir(), "peak-sessions-"));
  const manager = new SessionManager(base);
  for (const value of ["normal-name", "../evil", "nested/name", "", "."]) {
    assert.throws(() => manager.sessionDir(value), /UUID/);
  }
});

test("SessionManager resolves and activates an existing Session by name or UUID", () => {
  const base = mkdtempSync(join(tmpdir(), "peak-sessions-"));
  const manager = new SessionManager(base);
  const selected = manager.create("audit");
  const graph = manager.open(selected.id);
  graph.createProject({
    sessionId: selected.id, session: selected.name, name: selected.name,
    target: "x", goal: "g", worker: "mock", sessionDir: manager.sessionDir(selected.id),
    workspaceDir: base, configPath: join(base, "task.json"),
    taskConfig: { task: { target: "x", goal: "g" }, profiles: {}, workers: {} },
  });
  graph.close?.();
  assert.deepEqual(manager.resolve("audit"), selected);
  assert.deepEqual(manager.resolve(selected.id), selected);
});
