import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { GraphClient, GraphClientError } from "../dist/graph/graph-client.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";

test("HTTP is the complete persistent Graph protocol", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-graph-"));
  const registry = new ProjectStoreRegistry(root);
  const server = new GraphHttpServer(registry);
  await server.start({ token: "secret" });
  const graph = new GraphClient(server.baseUrl, "secret");
  try {
    const dashboard = await fetch(server.baseUrl);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /id="hint-form"/);
    await assert.rejects(
      new GraphClient(server.baseUrl, "wrong").listProjects(),
      (error: unknown) => error instanceof GraphClientError && error.status === 401,
    );
    const a = await graph.createProject({ title: "A", target: "origin A", goal: "goal A", scope: "shared" });
    const b = await graph.createProject({ title: "B", target: "origin B", goal: "goal B", scope: "shared" });
    const c = await graph.createProject({ title: "C", target: "origin C", goal: "goal C", scope: "other" });
    const hint = await graph.addHint(a.id, { content: "Verify the web entry point", creator: "human:web" });
    assert.equal(hint.creator, "human:web");
    assert.equal((await graph.getProject(a.id)).hints[0]?.content, "Verify the web entry point");
    const report = join(root, "report.md");
    const downloaded = join(root, "downloaded.md");
    writeFileSync(report, "full result\n");
    const artifact = await graph.uploadArtifact(a.id, report, "text/markdown");
    const intent = await graph.createIntent(a.id, {
      from: [{ projectId: a.id, factId: "origin" }], description: "Produce result", createdBy: "test",
    });
    const concluded = await graph.conclude(a.id, intent.id, { description: "Result summary", artifact, concludedBy: "test" });
    await graph.downloadArtifact(a.id, artifact.sha256, downloaded);
    assert.equal(readFileSync(downloaded, "utf8"), "full result\n");
    assert.equal((await graph.resolveFactRefs(b.id, [{ projectId: a.id, factId: concluded.fact.id }]))[0]?.fact.description, "Result summary");
    await graph.createIntent(b.id, {
      from: [{ projectId: a.id, factId: concluded.fact.id }], description: "Use A result", createdBy: "test",
    });
    await assert.rejects(
      graph.createIntent(c.id, { from: [{ projectId: a.id, factId: concluded.fact.id }], description: "bad scope", createdBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400,
    );
    await assert.rejects(
      graph.createIntent(b.id, { from: [{ projectId: a.id, factId: "goal" }], description: "bad goal", createdBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400,
    );
    await graph.complete(b.id, { from: [{ projectId: a.id, factId: concluded.fact.id }], description: "Goal proven", completedBy: "test" });
    assert.equal((await graph.getProject(b.id)).project.status, "completed");
    const open = (await graph.getProject(b.id)).intents.find((item) => item.to === null)!;
    await assert.rejects(
      graph.conclude(b.id, open.id, { description: "late", concludedBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 409,
    );
    await assert.rejects(graph.deleteProject(a.id), (error: unknown) => error instanceof GraphClientError && error.status === 409);
    assert.match(readFileSync(join(root, a.id, "logs", "main.log"), "utf8"), /intent_concluded/);

    const database = new DatabaseSync(join(root, a.id, "analysis.db"), { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    database.close();
    assert.deepEqual(tables, ["artifacts", "counters", "facts", "hints", "intent_sources", "intents", "project"]);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("open Intents survive a Graph Server restart without claim recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-restart-"));
  let registry = new ProjectStoreRegistry(root);
  let server = new GraphHttpServer(registry);
  await server.start();
  let graph = new GraphClient(server.baseUrl);
  const project = await graph.createProject({ title: "restart", target: "start", goal: "done" });
  await graph.createIntent(project.id, {
    from: [{ projectId: project.id, factId: "origin" }], description: "Remain open", createdBy: "test",
  });
  await server.stop();
  registry.close();

  registry = new ProjectStoreRegistry(root);
  server = new GraphHttpServer(registry);
  await server.start();
  graph = new GraphClient(server.baseUrl);
  try {
    const restored = await graph.getProject(project.id);
    assert.equal(restored.intents.length, 1);
    assert.equal(restored.intents[0]?.to, null);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
