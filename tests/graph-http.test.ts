import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { GraphClient, GraphClientError } from "../dist/graph/graph-client.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";
import { serveDashboard } from "../dist/ui/dashboard.js";

test("the optional UI composes without becoming a Graph Server dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-ui-"));
  const registry = new ProjectStoreRegistry(root);
  const server = new GraphHttpServer(registry, serveDashboard);
  await server.start();
  try {
    const response = await fetch(server.baseUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="hint-form"/);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP is the complete persistent Graph protocol", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-graph-"));
  const registry = new ProjectStoreRegistry(root);
  const server = new GraphHttpServer(registry);
  await server.start({ token: "secret" });
  const graph = new GraphClient(server.baseUrl, "secret");
  try {
    const rootResponse = await fetch(server.baseUrl);
    assert.equal(rootResponse.status, 404);
    await assert.rejects(
      new GraphClient(server.baseUrl, "wrong").listProjects(),
      (error: unknown) => error instanceof GraphClientError && error.status === 401,
    );
    const longGoal = "安".repeat(1365);
    const longGoalProject = await graph.createProject({ title: "long-goal", target: "origin", goal: longGoal });
    assert.equal((await graph.getProject(longGoalProject.id)).facts.find((fact) => fact.id === "goal")?.description, longGoal);
    await assert.rejects(
      graph.createProject({ title: "oversized-goal", target: "origin", goal: "安".repeat(1366) }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /4 KiB/.test(error.message),
    );
    const a = await graph.createProject({ title: "A", target: "origin A", goal: "goal A", scope: "shared" });
    const b = await graph.createProject({ title: "B", target: "origin B", goal: "goal B", scope: "shared" });
    const c = await graph.createProject({ title: "C", target: "origin C", goal: "goal C", scope: "other" });
    const d = await graph.createProject({ title: "D", target: "origin D", goal: "goal D" });
    const e = await graph.createProject({ title: "E", target: "origin E", goal: "goal E" });
    await assert.rejects(
      graph.addHint(a.id, { content: "安".repeat(342), creator: "human:web" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /1 KiB/.test(error.message),
    );
    const hint = await graph.addHint(a.id, { content: "Verify the web entry point", creator: "human:web" });
    assert.equal(hint.creator, "human:web");
    assert.equal((await graph.getProject(a.id)).hints[0]?.content, "Verify the web entry point");
    const report = join(root, "report.md");
    const downloaded = join(root, "downloaded.md");
    writeFileSync(report, "full result\n");
    const artifact = await graph.uploadArtifact(a.id, report, "text/markdown");
    await assert.rejects(
      graph.createIntent(a.id, {
        from: [{ projectId: a.id, factId: "origin", description: "origin A" }], description: "安".repeat(683), createdBy: "test",
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /2 KiB/.test(error.message),
    );
    const intent = await graph.createIntent(a.id, {
      from: [{ projectId: a.id, factId: "origin", description: "origin A" }], description: "Produce result", createdBy: "test",
    });
    await assert.rejects(
      graph.conclude(a.id, intent.id, { description: "安".repeat(342), artifact, concludedBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /1 KiB/.test(error.message),
    );
    const concluded = await graph.conclude(a.id, intent.id, { description: "Result summary", artifact, concludedBy: "test" });
    await graph.downloadArtifact(a.id, artifact.sha256, downloaded);
    assert.equal(readFileSync(downloaded, "utf8"), "full result\n");
    const resultRef = { projectId: a.id, factId: concluded.fact.id, description: concluded.fact.description };
    assert.equal((await graph.resolveFactRefs(b.id, [resultRef]))[0]?.fact.description, "Result summary");
    await assert.rejects(
      graph.resolveFactRefs(b.id, [{ ...resultRef, description: "tampered" }]),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /description mismatch/.test(error.message),
    );
    await graph.createIntent(b.id, {
      from: [resultRef], description: "Use A result", createdBy: "test",
    });
    assert.deepEqual((await graph.getProject(b.id)).intents[0]!.from, [resultRef]);
    const unscopedIntent = await graph.createIntent(d.id, {
      from: [{ projectId: d.id, factId: "origin", description: "origin D" }], description: "Produce reusable Board evidence", createdBy: "test",
    });
    const unscopedFact = await graph.conclude(d.id, unscopedIntent.id, { description: "Reusable evidence", concludedBy: "test" });
    await graph.createIntent(e.id, {
      from: [{ projectId: d.id, factId: unscopedFact.fact.id, description: "Reusable evidence" }], description: "Reuse sibling evidence", createdBy: "test",
    });
    await assert.rejects(
      graph.createIntent(c.id, { from: [resultRef], description: "bad scope", createdBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400,
    );
    await assert.rejects(
      graph.createIntent(b.id, { from: [{ projectId: a.id, factId: "goal", description: "goal A" }], description: "bad goal", createdBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400,
    );
    await graph.complete(b.id, { from: [resultRef], description: "Goal proven", completedBy: "test" });
    assert.equal((await graph.getProject(b.id)).project.status, "completed");
    const open = (await graph.getProject(b.id)).intents.find((item) => item.to === null)!;
    await assert.rejects(
      graph.conclude(b.id, open.id, { description: "late", concludedBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 409,
    );
    await assert.rejects(graph.deleteProject(a.id), (error: unknown) => error instanceof GraphClientError && error.status === 409);
    assert.match(readFileSync(join(root, a.id, "logs", "main.log"), "utf8"), /intent_concluded/);
    const exported = JSON.parse(await graph.exportProject(a.id)) as { project: { id: string } };
    assert.equal(exported.project.id, a.id);
    assert.ok(Array.isArray(JSON.parse(await graph.exportProject(a.id, "timeline"))));
    const invalidExport = await fetch(`${server.baseUrl}/api/projects/${a.id}/export?format=xml`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(invalidExport.status, 400);

    const database = new DatabaseSync(join(root, a.id, "analysis.db"), { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const sourceColumns = database.prepare("PRAGMA table_info(intent_sources)").all().map((row) => row.name);
    database.close();
    assert.deepEqual(tables, ["artifacts", "counters", "facts", "hints", "intent_sources", "intents", "project"]);
    assert.ok(sourceColumns.includes("source_description"));
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
    from: [{ projectId: project.id, factId: "origin", description: "start" }], description: "Remain open", createdBy: "test",
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
