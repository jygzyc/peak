import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GraphClient } from "../../dist/graph/graph-client.js";
import { GraphHttpServer } from "../../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../../dist/graph/project-store-registry.js";
import { loadTaskConfig } from "../../dist/utils/task-config.js";
import { prepareTaskProjects } from "../../dist/utils/task-preparer.js";

test("prepareTaskProjects fixes the complete UUID set before Dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-prepare-"));
  const registry = new ProjectStoreRegistry(join(root, "projects"));
  const server = new GraphHttpServer(registry);
  await server.start();
  try {
    writeFileSync(join(root, "task.json"), JSON.stringify({
      board: { name: "prepared", projects: [
        { id: "", source: "one", goal: "goal one" },
        { id: "", source: "two", goal: "goal two" },
      ] },
      workers: [{ type: "pi", taskTypes: ["supervise", "execute"] }],
    }));
    const ids = await prepareTaskProjects(loadTaskConfig(root), new GraphClient(server.baseUrl));
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2);
    const persisted = JSON.parse(readFileSync(join(root, "task.json"), "utf8")) as {
      board: { projects: Array<{ id: string }> };
    };
    assert.deepEqual(persisted.board.projects.map((project) => project.id), ids);
    assert.deepEqual(await prepareTaskProjects(loadTaskConfig(root), new GraphClient(server.baseUrl)), ids);
    assert.equal(registry.list().length, 2, "repeated preparation must reuse Projects");
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
