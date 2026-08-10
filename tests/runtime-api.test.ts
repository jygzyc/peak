import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { runtimeExecutionsExtension, runtimeStatusExtension } from "../dist/runtime/runtime-api.js";
import { ExecutionRegistry } from "../dist/runtime/execution-registry.js";
import { RuntimeStatus } from "../dist/runtime/runtime-api.js";

async function start(extensions: never[] = []): Promise<{ server: GraphHttpServer; registry: ProjectStoreRegistry; cleanup: () => Promise<void> }> {
  const projects = mkdtempSync(join(tmpdir(), "peak-rtapi-"));
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry, undefined, extensions);
  await server.start();
  const cleanup = async (): Promise<void> => { await server.stop(); registry.close(); rmSync(projects, { recursive: true, force: true }); };
  return { server, registry, cleanup };
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("GET /api/runtime/status returns the heartbeat snapshot", async () => {
  const status = new RuntimeStatus();
  status.start(1_000);
  const { server, cleanup } = await start([runtimeStatusExtension(status)] as never[]);
  try {
    const result = await get(server.baseUrl, "/api/runtime/status");
    assert.equal(result.status, 200);
    const body = result.body as Record<string, unknown>;
    assert.ok(typeof body.runtimeId === "string");
    assert.ok(typeof body.heartbeatAt === "number");
    assert.ok(typeof body.heartbeatWindowMs === "number");
    assert.equal(body.schedulerRunning, true);
  } finally {
    status.stop();
    await cleanup();
  }
});

test("GET /api/runtime/projects/:id/executions filters by Project and hides internals", async () => {
  const executions = new ExecutionRegistry();
  const projectId = "11111111-1111-1111-1111-111111111111";
  const controller = new AbortController();
  const id = executions.createId();
  executions.add({ executionId: id, projectId, kind: "execute", intentId: "i0001", workerName: "pi", processId: 4242, startedAt: Date.now(), deadlineAt: Date.now() + 10_000, controller });
  const other = executions.createId();
  executions.add({ executionId: other, projectId: "22222222-2222-2222-2222-222222222222", kind: "plan", startedAt: Date.now(), controller: new AbortController() });
  const { server, cleanup } = await start([runtimeExecutionsExtension(executions)] as never[]);
  try {
    const result = await get(server.baseUrl, `/api/runtime/projects/${projectId}/executions`);
    assert.equal(result.status, 200);
    const list = result.body as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    const item = list[0]!;
    assert.deepEqual(Object.keys(item).sort(), ["deadlineAt", "executionId", "intentId", "kind", "processId", "projectId", "startedAt", "workerName"]);
    assert.equal(item.intentId, "i0001");
    assert.equal(item.processId, 4242);
    assert.equal(item.workerName, "pi");
    assert.equal("controller" in item, false, "controller must not leak");
  } finally { await cleanup(); }
});

test("Runtime endpoints are absent when no extensions are injected (peak serve)", async () => {
  const { server, cleanup } = await start();
  try {
    const result = await get(server.baseUrl, "/api/runtime/status");
    assert.equal(result.status, 404);
  } finally { await cleanup(); }
});
