import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeStatus, RUNTIME_HEARTBEAT_WINDOW_MS } from "../dist/runtime/runtime-status.js";

test("RuntimeStatus advances heartbeatAt and sequence once started", async () => {
  const status = new RuntimeStatus();
  const before = status.snapshot();
  assert.equal(before.schedulerRunning, false, "not running before start");
  status.start(20);
  const started = status.snapshot();
  assert.equal(started.schedulerRunning, true);
  assert.ok(started.sequence >= 1, "first beat advances sequence");
  assert.ok(started.heartbeatAt >= before.heartbeatAt);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const later = status.snapshot();
  assert.ok(later.sequence > started.sequence, "interval keeps advancing sequence");
  status.stop();
  assert.equal(status.snapshot().schedulerRunning, false, "stopped flips schedulerRunning");
});

test("snapshot DTO exposes only the public liveness fields", () => {
  const status = new RuntimeStatus();
  status.start(1_000);
  try {
    const keys = Object.keys(status.snapshot()).sort();
    assert.deepEqual(keys, ["heartbeatAt", "runtimeId", "schedulerRunning", "sequence", "startedAt"]);
  } finally { status.stop(); }
});

test("isStale treats a fresh heartbeat as live and a stale one as offline", () => {
  const status = new RuntimeStatus();
  status.start(1_000);
  try {
    const now = status.snapshot().heartbeatAt;
    assert.equal(status.isStale(now), false);
    assert.equal(status.isStale(now + RUNTIME_HEARTBEAT_WINDOW_MS + 1), true);
  } finally { status.stop(); }
});

test("RuntimeStatus is safe to start and stop multiple times", () => {
  const status = new RuntimeStatus();
  status.start(1_000);
  status.start(1_000);
  status.stop();
  status.stop();
  assert.equal(status.snapshot().schedulerRunning, false);
});
