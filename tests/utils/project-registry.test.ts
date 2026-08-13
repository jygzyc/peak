import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deregisterProject, deregisterRuntime, heartbeatRuntime, listProjectRegistrations, projectsRegistryPath,
  ProjectRegistrationConflictError, projectRegistrationExtension, registerProjects, taskFederationProjectIds, updateRuntimeWebUrl,
  type ProjectRegistrationEntry,
} from "../../dist/utils/project-registry.js";
import { GraphHttpServer } from "../../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../../dist/graph/project-store-registry.js";

function entry(partial: Partial<ProjectRegistrationEntry> & { projectId: string }): ProjectRegistrationEntry {
  return {
    taskName: "task", boardDir: "/board", mode: "start", runtimeId: "a1b2c3d4",
    pid: process.pid, container: null, graphUrl: null, webUrl: null,
    startedAt: new Date().toISOString(), ...partial,
  };
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("Server .projects.json leases reject conflicts atomically and permit takeover after TTL", async () => {
  const peakHome = mkdtempSync(join(tmpdir(), "peak-leases-"));
  try {
    const first = entry({ projectId: randomUUID() });
    const mount = [first.projectId];
    const [lease] = registerProjects(peakHome, [first], mount, 120);
    assert.equal(lease?.projectId, first.projectId);
    assert.ok(Date.parse(lease!.expiresAt) > Date.parse(lease!.heartbeatAt));
    assert.equal(existsSync(projectsRegistryPath(peakHome)), true);
    assert.equal(JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(projectsRegistryPath(peakHome), "utf8"))).version, 3);
    assert.deepEqual(taskFederationProjectIds(peakHome, "task"), mount);
    const alienProjectId = randomUUID();
    assert.throws(
      () => registerProjects(peakHome, [entry({ projectId: alienProjectId, runtimeId: "ffffffff" })], [alienProjectId], 120),
      /already fixed/,
    );

    assert.throws(
      () => registerProjects(peakHome, [entry({ projectId: first.projectId, runtimeId: "ffffffff" })], mount, 120),
      (error: unknown) => error instanceof ProjectRegistrationConflictError && error.projectId === first.projectId,
    );
    assert.deepEqual(listProjectRegistrations(peakHome).map((item) => item.projectId), [first.projectId]);

    await wait(150);
    assert.deepEqual(listProjectRegistrations(peakHome), []);
    assert.equal(registerProjects(peakHome, [entry({ ...first, runtimeId: "ffffffff" })], mount, 120)[0]?.runtimeId, "ffffffff");
  } finally { rmSync(peakHome, { recursive: true, force: true }); }
});

test("heartbeat extends leases and release remains owner checked", async () => {
  const peakHome = mkdtempSync(join(tmpdir(), "peak-leases-"));
  try {
    const first = entry({ projectId: randomUUID() });
    const second = entry({ projectId: randomUUID() });
    registerProjects(peakHome, [first, second], [first.projectId, second.projectId], 160);
    await wait(90);
    assert.equal(heartbeatRuntime(peakHome, first.runtimeId, 160), true);
    await wait(90);
    assert.equal(listProjectRegistrations(peakHome).length, 2);

    updateRuntimeWebUrl(peakHome, first.runtimeId, "http://127.0.0.1:1234");
    assert.ok(listProjectRegistrations(peakHome).every((item) => item.webUrl === "http://127.0.0.1:1234"));
    assert.equal(deregisterProject(peakHome, first.projectId, "99999999"), false);
    assert.equal(deregisterProject(peakHome, first.projectId, first.runtimeId), true);
    deregisterRuntime(peakHome, second.runtimeId);
    assert.deepEqual(listProjectRegistrations(peakHome), []);
  } finally { rmSync(peakHome, { recursive: true, force: true }); }
});

test("lease API acquires, heartbeats, conflicts, expires, and releases", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-lease-api-"));
  const registry = new ProjectStoreRegistry(join(root, "projects"));
  const server = new GraphHttpServer(registry, undefined, [projectRegistrationExtension(root, 120)]);
  await server.start({ port: 0 });
  try {
    const projectId = randomUUID();
    const body = { taskName: "task", projectIds: [projectId], boardDir: "/board", mode: "start", runtimeId: "a1b2c3d4", pid: process.pid };
    const request = (method: string, value: unknown) => fetch(`${server.baseUrl}/api/projects/${projectId}/registration`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    });
    assert.equal((await request("POST", body)).status, 201);
    assert.equal((await request("POST", { ...body, runtimeId: "ffffffff" })).status, 409);
    await wait(70);
    assert.equal((await request("PUT", { runtimeId: body.runtimeId })).status, 200);
    await wait(70);
    assert.equal((await request("POST", { ...body, runtimeId: "ffffffff" })).status, 409);
    await wait(70);
    assert.equal((await request("PUT", { runtimeId: body.runtimeId })).status, 409);
    assert.equal((await request("POST", { ...body, runtimeId: "ffffffff" })).status, 201);
    assert.equal((await request("DELETE", { runtimeId: "ffffffff" })).status, 204);
  } finally {
    await server.stop(); registry.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
