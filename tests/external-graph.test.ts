import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolvedTaskConfig } from "../dist/utils/types.js";
import { GraphClient } from "../dist/graph/graph-client.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";
import { AgentRuntime } from "../dist/runtime/agent-runtime.js";

test("AgentRuntime attaches through an external Graph URL in attach-only mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-external-graph-"));
  const serverProjects = join(root, "server-projects");
  const registry = new ProjectStoreRegistry(serverProjects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const admin = new GraphClient(server.baseUrl, { projectsRoot: serverProjects });
  try {
    const project = await admin.createProject({ title: "P", target: "start", goal: "done" });
    const runtime = new AgentRuntime(
      configuration(root, "start", "done", project.id),
      { graphUrl: server.baseUrl, projectsRoot: join(root, "runtime-projects"), attachOnly: true, installSkills: false },
    );
    const projects = await runtime.start();
    assert.deepEqual(projects.map((item) => item.id), [project.id]);
    assert.equal(runtime.endpointUrl, server.baseUrl);
    assert.equal(runtime.graphClient.baseUrl, server.baseUrl);
    await runtime.stop();

    // Attach-only never creates: a configured Project without an id is rejected.
    const creating = new AgentRuntime(
      configuration(root, "start", "done"),
      { graphUrl: server.baseUrl, projectsRoot: join(root, "runtime-projects"), attachOnly: true, installSkills: false },
    );
    await assert.rejects(creating.start(), /attach-only/);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function configuration(root: string, source: string, goal: string, id?: string): ResolvedTaskConfig {
  return {
    configPath: join(root, "task.json"), taskDir: root,
    board: { skills: [], projects: [{ id, source, goal }] },
    workers: { fake: { type: "pi", taskTypes: ["plan", "supervise", "execute"], maxRunning: 1, priority: 1, env: {} } },
    scheduler: { maxRunningProjects: 4, intervalMs: 60_000 },
    phase: {
      plan: {},
      supervise: { intervalMs: 60_000 },
      execute: { maxArtifactBytes: 1024, customProfile: [] },
    },
  };
}
