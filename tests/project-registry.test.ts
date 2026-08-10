import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deregisterProject, deregisterRuntime, listProjectRegistrations, ProjectRegistrationConflictError, projectsRegistryPath,
  registerProjects, updateRuntimeWebUrl, type ProjectRegistration,
} from "../dist/utils/project-registry.js";
import { projectRegistrationExtension } from "../dist/utils/project-registry.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";

function entry(partial: Partial<ProjectRegistration> & { projectId: string }): ProjectRegistration {
  return {
    taskName: "task",
    boardDir: "/board",
    mode: "start",
    runtimeId: "a1b2c3d4",
    pid: process.pid,
    container: null,
    graphUrl: null,
    webUrl: null,
    startedAt: new Date().toISOString(),
    ...partial,
  };
}

test("registry registers, rejects conflicts atomically, and prunes stale entries", async () => {
  const peakHome = mkdtempSync(join(tmpdir(), "peak-registry-"));
  try {
    const first = entry({ projectId: randomUUID() });
    registerProjects(peakHome, [first]);
    assert.deepEqual(listProjectRegistrations(peakHome), [first]);

    // A conflicting batch is rejected as a whole: no partial registration.
    assert.throws(
      () => registerProjects(peakHome, [entry({ projectId: randomUUID(), runtimeId: "ffffffff" }), entry({ projectId: first.projectId })]),
      (error: unknown) => error instanceof ProjectRegistrationConflictError && error.projectId === first.projectId,
    );
    assert.deepEqual(listProjectRegistrations(peakHome), [first]);

    // Dead-pid entries are pruned on read.
    const zombie = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => zombie.once("exit", resolve));
    registerProjects(peakHome, [entry({ projectId: randomUUID(), pid: zombie.pid!, runtimeId: "deadbeef" })]);
    assert.deepEqual(listProjectRegistrations(peakHome).map((item) => item.runtimeId), [first.runtimeId]);

    // Container entries (no pid) survive pruning.
    registerProjects(peakHome, [entry({ projectId: randomUUID(), pid: null, container: "peak_abc123", runtimeId: "c0ffee00" })]);
    assert.equal(listProjectRegistrations(peakHome).length, 2);
  } finally {
    rmSync(peakHome, { recursive: true, force: true });
  }
});

test("registry updates webUrl and deregisters by runtime and by project", () => {
  const peakHome = mkdtempSync(join(tmpdir(), "peak-registry-"));
  try {
    const first = entry({ projectId: randomUUID() });
    const second = entry({ projectId: randomUUID() });
    registerProjects(peakHome, [first, second]);
    updateRuntimeWebUrl(peakHome, first.runtimeId, "http://127.0.0.1:1234");
    assert.ok(listProjectRegistrations(peakHome).every((item) => item.webUrl === "http://127.0.0.1:1234"));

    assert.equal(deregisterProject(peakHome, first.projectId, "99999999" as string), false);
    assert.equal(deregisterProject(peakHome, first.projectId, first.runtimeId), true);
    assert.deepEqual(listProjectRegistrations(peakHome).map((item) => item.projectId), [second.projectId]);

    deregisterRuntime(peakHome, second.runtimeId);
    assert.deepEqual(listProjectRegistrations(peakHome), []);
    assert.throws(() => updateRuntimeWebUrl(peakHome, second.runtimeId, "http://x"), /no registration/);
  } finally {
    rmSync(peakHome, { recursive: true, force: true });
  }
});

test("registration API extension registers, conflicts with 409, and deregisters", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-registration-api-"));
  const registry = new ProjectStoreRegistry(join(root, "projects"));
  const server = new GraphHttpServer(registry, undefined, [projectRegistrationExtension(root)]);
  await server.start({ port: 0 });
  try {
    const projectId = randomUUID();
    const body = { taskName: "task", boardDir: "/board", mode: "start", runtimeId: "a1b2c3d4", pid: process.pid };
    const created = await fetch(`${server.baseUrl}/api/projects/${projectId}/registration`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(created.status, 201);
    const recorded = await created.json() as ProjectRegistration;
    assert.equal(recorded.projectId, projectId);
    assert.equal(recorded.pid, process.pid);
    assert.equal(listProjectRegistrations(root).length, 1);

    const conflict = await fetch(`${server.baseUrl}/api/projects/${projectId}/registration`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, runtimeId: "ffffffff" }),
    });
    assert.equal(conflict.status, 409);

    const unknownField = await fetch(`${server.baseUrl}/api/projects/${randomUUID()}/registration`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, bogus: true }),
    });
    assert.equal(unknownField.status, 400);

    const wrongRuntime = await fetch(`${server.baseUrl}/api/projects/${projectId}/registration`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtimeId: "ffffffff" }),
    });
    assert.equal(wrongRuntime.status, 404);

    const removed = await fetch(`${server.baseUrl}/api/projects/${projectId}/registration`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtimeId: "a1b2c3d4" }),
    });
    assert.equal(removed.status, 204);
    assert.equal(listProjectRegistrations(root).length, 0);
    assert.equal(projectsRegistryPath(root).endsWith(".projects.json"), true);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
