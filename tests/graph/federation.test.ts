import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { GraphClient } from "../../dist/graph/graph-client.js";
import { GraphHttpServer } from "../../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../../dist/graph/project-store-registry.js";

const execFileAsync = promisify(execFile);

test("Joint Plan discovers current leaf Paths from active and completed same-Task Projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-joint-plan-"));
  const registry = new ProjectStoreRegistry(join(root, "projects"));
  let mounted: string[] | undefined;
  const server = new GraphHttpServer(registry, undefined, [], (taskName) => taskName === "joint" ? mounted : undefined);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const active = await graph.createProject({ title: "active", target: "active source", goal: "goal", scope: "one" });
    const completed = await graph.createProject({ title: "completed", target: "completed source", goal: "goal", scope: "two" });
    const target = await graph.createProject({ title: "target", target: "target source", goal: "goal" });
    mounted = [active.id, completed.id, target.id];

    const activeIntent = await graph.createIntent(active.id, {
      from: [{ projectId: active.id, id: "origin", description: "active source" }],
      description: "produce active evidence", createdBy: "test",
    });
    const activeFact = (await graph.conclude(active.id, activeIntent.id, {
      description: "active evidence", artifact: null, concludedBy: "test",
    })).fact;
    const completedIntent = await graph.createIntent(completed.id, {
      from: [{ projectId: completed.id, id: "origin", description: "completed source" }],
      description: "produce completed evidence", createdBy: "test",
    });
    const completedFact = (await graph.conclude(completed.id, completedIntent.id, {
      description: "completed evidence", artifact: null, concludedBy: "test",
    })).fact;
    await graph.complete(completed.id, {
      from: [{ projectId: completed.id, id: completedFact.id, description: completedFact.description }],
      description: "goal proven", completedBy: "test",
    });

    const paths = await graph.jointPlanPaths({ taskName: "joint" }, target.id);
    assert.deepEqual(paths.map((path) => [path.projectId, path.leaf.id]), [
      [active.id, activeFact.id],
      [completed.id, completedFact.id],
    ]);
    assert.deepEqual(paths[0]!.segments[0]!.map((fact) => fact.id), ["origin", activeFact.id]);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Joint Plan is an HTTP pull and requires the Server-pinned Task mount", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-http-joint-plan-"));
  const registry = new ProjectStoreRegistry(join(root, "projects"));
  let mounted: string[] | undefined;
  const server = new GraphHttpServer(registry, undefined, [], (taskName) => taskName === "distributed" ? mounted : undefined);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const source = await graph.createProject({ title: "source", target: "source", goal: "goal" });
    const target = await graph.createProject({ title: "target", target: "target", goal: "goal" });
    mounted = [source.id, target.id];
    const intent = await graph.createIntent(source.id, {
      from: [{ projectId: source.id, id: "origin", description: "source" }],
      description: "produce evidence", createdBy: "test",
    });
    const fact = (await graph.conclude(source.id, intent.id, {
      description: "evidence", artifact: null, concludedBy: "test",
    })).fact;
    const env = {
      ...process.env,
      PEAK_TEST_URL: server.baseUrl,
      PEAK_TEST_TARGET: target.id,
    };
    const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", [
      'import { GraphClient } from "./dist/graph/graph-client.js";',
      "const graph = new GraphClient(process.env.PEAK_TEST_URL);",
      'const paths = await graph.jointPlanPaths({ taskName: "distributed" }, process.env.PEAK_TEST_TARGET);',
      "process.stdout.write(JSON.stringify(paths));",
    ].join("\n")], { cwd: process.cwd(), env });
    assert.deepEqual(JSON.parse(result.stdout).map((path: { projectId: string; leaf: { id: string } }) => [path.projectId, path.leaf.id]), [
      [source.id, fact.id],
    ]);
    await assert.rejects(graph.jointPlanPaths({ taskName: "unmounted" }, target.id), /not mounted/);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
