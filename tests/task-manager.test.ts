import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { taskManagerExtension } from "../dist/utils/task-manager.js";
import type { TaskManagerContext } from "../dist/utils/task-manager.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";

interface TaskSummary {
  name: string;
  status: "running" | "stopped";
  runtime: { mode: string; pid: number | null; container: string | null } | null;
  projects: Array<{ id: string; title: string; status: string }>;
}

async function api(baseUrl: string, path: string, method = "GET", body?: unknown): Promise<{ status: number; body: never }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed as never };
}

function validTask(name: string): unknown {
  return {
    name,
    projects: [{ source: "Managed inputs", goal: "managed result" }],
    workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"], maxRunning: 1, priority: 1, env: {} }],
  };
}

test("task management API validates, lists, starts, stops, and deletes tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-task-manager-"));
  const peakHome = join(root, "peak-home");
  const projectsDir = join(root, "projects");
  const registry = new ProjectStoreRegistry(projectsDir);
  const context: TaskManagerContext = {
    peakHome,
    projectsDir,
    registry,
    cliEntry: resolve("dist", "cli.js"),
    serveUrl: "",
    version: "0.0.0-test",
  };
  const server = new GraphHttpServer(registry, undefined, [taskManagerExtension(context)]);
  await server.start({ port: 0 });
  context.serveUrl = server.baseUrl;
  try {
    // Schema validation: an unknown worker type is rejected and the scaffold removed.
    const invalid = await api(server.baseUrl, "/api/tasks", "POST", {
      name: "bad", projects: [{ source: "s", goal: "g" }], workers: [{ type: "nope", taskTypes: ["execute"] }],
    });
    assert.equal(invalid.status, 400);
    assert.equal(existsSync(join(peakHome, "tasks", "bad")), false);

    const created = await api(server.baseUrl, "/api/tasks", "POST", validTask("managed"));
    assert.equal(created.status, 201);
    assert.ok(existsSync(join(peakHome, "tasks", "managed", "task.json")));

    const duplicate = await api(server.baseUrl, "/api/tasks", "POST", validTask("managed"));
    assert.equal(duplicate.status, 409);

    const listed = await api(server.baseUrl, "/api/tasks");
    assert.equal(listed.status, 200);
    const before = (listed.body as { tasks: TaskSummary[] }).tasks.find((task) => task.name === "managed");
    assert.equal(before?.status, "stopped");

    // Start (local): the server spawns `peak start --foreground --graph-url`.
    const started = await api(server.baseUrl, "/api/tasks/managed/start", "POST", { runtime: "local" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const during = (await api(server.baseUrl, "/api/tasks")).body as { tasks: TaskSummary[] };
    const running = during.tasks.find((task) => task.name === "managed");
    assert.equal(running?.status, "running");
    assert.ok(running?.runtime?.pid, "local start records the spawned pid");
    assert.equal(running?.projects.length, 1);
    assert.match(running?.projects[0]?.id ?? "", /^[0-9a-f-]{36}$/);

    const again = await api(server.baseUrl, "/api/tasks/managed/start", "POST", { runtime: "local" });
    assert.equal(again.status, 409);

    const stopped = await api(server.baseUrl, "/api/tasks/managed/stop", "POST");
    assert.equal(stopped.status, 200);
    const afterStop = (await api(server.baseUrl, "/api/tasks")).body as { tasks: TaskSummary[] };
    assert.equal(afterStop.tasks.find((task) => task.name === "managed")?.status, "stopped");

    // Default delete keeps Project data; the Board directory is removed.
    const projectId = running!.projects[0]!.id;
    const removed = await api(server.baseUrl, "/api/tasks/managed", "DELETE");
    assert.equal(removed.status, 200);
    assert.equal(existsSync(join(peakHome, "tasks", "managed")), false);
    assert.equal(existsSync(join(projectsDir, projectId)), true, "Project shard preserved by default");
    assert.equal((await registry.list().length), 1);

    // Purge deletes the Project shards through the registry (stores closed).
    await api(server.baseUrl, "/api/tasks", "POST", validTask("purged"));
    await api(server.baseUrl, "/api/tasks/purged/start", "POST", { runtime: "local" });
    const purgedTasks = (await api(server.baseUrl, "/api/tasks")).body as { tasks: TaskSummary[] };
    const purgedId = purgedTasks.tasks.find((task) => task.name === "purged")?.projects[0]?.id;
    assert.ok(purgedId);
    const purged = await api(server.baseUrl, "/api/tasks/purged?purge=true", "DELETE");
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    assert.equal(existsSync(join(projectsDir, purgedId)), false, "purged Project shard removed");
  } finally {
    // Ensure no spawned task process outlives the test.
    spawnSync(process.execPath, ["dist/cli.js", "stop", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    await server.stop();
    registry.close();
    cleanup(root);
  }
});

function cleanup(path: string): void {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    const removed = spawnSync("powershell.exe", ["-NoProfile", "-Command", "& { param([string]$target) Remove-Item -LiteralPath $target -Recurse -Force }", path], {
      encoding: "utf8",
    });
    assert.equal(removed.status, 0, removed.stderr);
  }
}
