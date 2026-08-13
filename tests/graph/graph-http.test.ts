import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { customProfileDigest } from "../../dist/utils/types.js";
import { GraphClient, GraphClientError } from "../../dist/graph/graph-client.js";
import { GraphHttpServer } from "../../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../../dist/graph/project-store-registry.js";
import { leafFacts } from "../../dist/graph/types.js";
import { serveDashboard } from "../../dist/ui/dashboard.js";

test("the optional UI composes without becoming a Graph Server dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-ui-"));
  const registry = new ProjectStoreRegistry(root);
  const server = new GraphHttpServer(registry, serveDashboard);
  await server.start();
  try {
    const response = await fetch(server.baseUrl);
    assert.equal(response.status, 200);
    const html = await response.text();
    // The HTML shells only bootstrap the Lit bundle: all markup, styles and
    // logic live in TypeScript and are compiled into scripts/app.js.
    assert.match(html, /<peak-dashboard>/);
    assert.match(html, /scripts\/app\.js/);
    const bundle = await (await fetch(`${server.baseUrl}/scripts/app.js`)).text();
    assert.match(bundle, /id="hint-form"/);
    assert.match(bundle, /Custom profile/);
    assert.match(bundle, /\/preview\.html/);
    assert.match(bundle, /peak-node-enter/);
    assert.match(bundle, /peak-run-pulse/);
    assert.match(bundle, /PROOF DAG/);
    assert.match(bundle, /peak-dashboard/);
    assert.match(bundle, /peak-tasks/);
    assert.match(bundle, /peak-preview/);
    assert.doesNotMatch(html, /global timeline/);
    assert.doesNotMatch(html, /kind-filter|Prompt kind/);
    const preview = await fetch(`${server.baseUrl}/preview.html`);
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /<peak-preview>/);
    const tasks = await fetch(`${server.baseUrl}/tasks.html`);
    assert.equal(tasks.status, 200);
    const tasksHtml = await tasks.text();
    assert.match(tasksHtml, /<peak-tasks>/);
    assert.match(bundle, /Existing tasks/);
    assert.match(bundle, /Create task/);
    assert.match(bundle, /\/api\/tasks/);
    assert.equal((await fetch(`${server.baseUrl}/missing.html`)).status, 404);
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
  await server.start();
  const graph = new GraphClient(server.baseUrl, { projectsRoot: root });
  try {
    const rootResponse = await fetch(server.baseUrl);
    assert.equal(rootResponse.status, 404);
    const longGoal = "安".repeat(1365);
    const longGoalProject = await graph.createProject({ title: "long-goal", target: "origin", goal: longGoal });
    assert.equal((await graph.getProject(longGoalProject.id)).facts.find((fact) => fact.id === "goal")?.description, longGoal);
    await assert.rejects(
      graph.createProject({ title: "oversized-goal", target: "origin", goal: "安".repeat(1366) }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /4 KiB/.test(error.message),
    );
    const a = await graph.createProject({ title: "A", target: "origin A", goal: "goal A", scope: "shared" });
    const reserved = await graph.getProject(a.id);
    assert.match(reserved.project.createdAt, /^\d{8}T\d{6}\.\d{3}$/);
    assert.ok(reserved.facts.every((fact) => /^\d{8}T\d{6}\.\d{3}$/.test(fact.createdAt)));
    assert.ok(reserved.facts.every((fact) => fact.artifact === null));
    assert.ok(reserved.facts.every((fact) => !("kind" in fact) && !("customProfile" in fact)));
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
    writeFileSync(report, "full result\n");
    const artifact = await graph.uploadArtifact(a.id, report, "text/markdown");
    await assert.rejects(
      graph.createIntent(a.id, {
        from: [{ projectId: a.id, id: "origin", description: "origin A" }], description: "安".repeat(683), createdBy: "test",
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /2 KiB/.test(error.message),
    );
    const profile = { description: "Use for primary-source research.", prompt: "Collect primary evidence.", skills: [] };
    const intent = await graph.createIntent(a.id, {
      from: [{ projectId: a.id, id: "origin", description: "origin A" }],
      customProfile: profile.description,
      customProfileDigest: customProfileDigest(profile),
      hintIds: [hint.id], description: "Produce result", createdBy: "test",
    });
    assert.equal(intent.customProfile, profile.description);
    assert.equal(intent.customProfileDigest, customProfileDigest(profile));
    assert.deepEqual(intent.hintIds, [hint.id]);
    assert.equal((await graph.getProject(a.id)).hints[0]?.consumedByIntentId, intent.id);
    await assert.rejects(
      graph.conclude(a.id, intent.id, { description: "安".repeat(342), artifact, concludedBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /1 KiB/.test(error.message),
    );
    const concluded = await graph.conclude(a.id, intent.id, { description: "Result summary", artifact, concludedBy: "test" });
    assert.ok(!("kind" in concluded.fact) && !("customProfile" in concluded.fact));
    const resultRef = { projectId: a.id, id: concluded.fact.id, description: concluded.fact.description };
    await assert.rejects(
      graph.createIntent(a.id, {
        from: [{ projectId: a.id, id: "origin", description: "origin A" }], description: "Use historical source", createdBy: "test",
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 409 && /not a current leaf/.test(error.message),
    );
    await assert.rejects(
      graph.complete(a.id, {
        from: [{ projectId: a.id, id: "origin", description: "origin A" }], description: "Complete from history", completedBy: "test",
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 409 && /not a current leaf/.test(error.message),
    );
    const [resolved] = await graph.resolveFactRefs(a.id, [resultRef]);
    assert.equal(resolved?.fact.description, "Result summary");
    assert.equal(resolved?.fact.artifact?.readOnly, true);
    assert.equal(readFileSync(resolved!.fact.artifact!.inputPath, "utf8"), "full result\n");
    await assert.rejects(
      graph.resolveFactRefs(a.id, [{ ...resultRef, description: "tampered" }]),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /description mismatch/.test(error.message),
    );
    // Cross-Project FactRefs are rejected outright: Federation Paths are the
    // only cross-Project channel, and they are read-only references.
    await assert.rejects(
      graph.resolveFactRefs(b.id, [resultRef]),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /local Fact/.test(error.message),
    );
    await assert.rejects(
      graph.createIntent(b.id, { from: [resultRef], description: "Use A result", createdBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /local Fact/.test(error.message),
    );
    await assert.rejects(
      graph.complete(b.id, { from: [resultRef], description: "Goal proven", completedBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /local Fact/.test(error.message),
    );
    const unscopedIntent = await graph.createIntent(d.id, {
      from: [{ projectId: d.id, id: "origin", description: "origin D" }], description: "Produce reusable Board evidence", createdBy: "test",
    });
    const unscopedFact = await graph.conclude(d.id, unscopedIntent.id, { description: "Reusable evidence", artifact: null, concludedBy: "test" });
    assert.equal(unscopedFact.fact.artifact, null);
    const [resolvedWithoutArtifact] = await graph.resolveFactRefs(d.id, [{
      projectId: d.id, id: unscopedFact.fact.id, description: "Reusable evidence",
    }]);
    assert.equal(resolvedWithoutArtifact?.fact.artifact, null);
    await assert.rejects(
      graph.createIntent(e.id, {
        from: [{ projectId: d.id, id: unscopedFact.fact.id, description: "Reusable evidence" }], description: "Reuse sibling evidence", createdBy: "test",
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /local Fact/.test(error.message),
    );
    const updateIntent = await graph.createIntent(d.id, {
      from: [{ projectId: d.id, id: unscopedFact.fact.id, description: "Reusable evidence" }], description: "Advance reusable evidence", createdBy: "test",
    });
    await graph.conclude(d.id, updateIntent.id, { description: "Updated reusable evidence", artifact: null, concludedBy: "test" });
    await assert.rejects(
      graph.createIntent(c.id, { from: [resultRef], description: "bad scope", createdBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400,
    );
    await assert.rejects(
      graph.createIntent(b.id, { from: [{ projectId: a.id, id: "goal", description: "goal A" }], description: "bad goal", createdBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400,
    );
    const bIntent = await graph.createIntent(b.id, {
      from: [{ projectId: b.id, id: "origin", description: "origin B" }], description: "Produce B result", createdBy: "test",
    });
    const bOpen = await graph.createIntent(b.id, {
      from: [{ projectId: b.id, id: "origin", description: "origin B" }], description: "Leave open", createdBy: "test",
    });
    const bFact = await graph.conclude(b.id, bIntent.id, { description: "B result", artifact: null, concludedBy: "test" });
    await graph.complete(b.id, {
      from: [{ projectId: b.id, id: bFact.fact.id, description: bFact.fact.description }], description: "Goal proven", completedBy: "test",
    });
    assert.equal((await graph.getProject(b.id)).project.status, "completed");
    const open = (await graph.getProject(b.id)).intents.find((item) => item.to === null)!;
    assert.equal(open.id, bOpen.id);
    const latePath = join(root, "late.md");
    writeFileSync(latePath, "late\n");
    const lateArtifact = await graph.uploadArtifact(b.id, latePath, "text/markdown");
    await assert.rejects(
      graph.conclude(b.id, open.id, { description: "late", artifact: lateArtifact, concludedBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 409,
    );
    const disposable = await graph.createProject({ title: "disposable", target: "disposable origin", goal: "disposable goal" });
    await graph.deleteProject(disposable.id);
    await assert.rejects(
      graph.getProject(disposable.id),
      (error: unknown) => error instanceof GraphClientError && error.status === 404,
    );

    const reopenProject = await graph.createProject({ title: "reopen", target: "reopen origin", goal: "reopen goal" });
    const beforeFeedback = await graph.createIntent(reopenProject.id, {
      from: [{ projectId: reopenProject.id, id: "origin", description: "reopen origin" }], description: "Establish current state", createdBy: "test",
    });
    const beforeFeedbackFact = await graph.conclude(reopenProject.id, beforeFeedback.id, {
      description: "Current state before feedback", artifact: null, concludedBy: "test",
    });
    await graph.complete(reopenProject.id, {
      from: [{ projectId: reopenProject.id, id: beforeFeedbackFact.fact.id, description: beforeFeedbackFact.fact.description }],
      description: "Initial goal proof", completedBy: "test",
    });
    const reopened = await graph.reopen(reopenProject.id, { description: "External correction", creator: "human:test" });
    const feedbackIntent = reopened.intents.find((item) => item.description === "External feedback")!;
    assert.deepEqual(feedbackIntent.from, [{
      projectId: reopenProject.id, id: beforeFeedbackFact.fact.id, description: beforeFeedbackFact.fact.description,
    }]);
    assert.deepEqual(leafFacts(reopened).map((fact) => fact.description), ["External correction"]);
    const operations = readFileSync(join(root, a.id, "logs", "main.log"), "utf8").trim().split(/\r?\n/)
      .map((line) => JSON.parse(line) as { at: string; type: string });
    assert.ok(operations.some((event) => event.type === "intent_concluded"));
    assert.ok(operations.every((event) => /^\d{8}T\d{6}\.\d{3}$/.test(event.at)));
    const exported = JSON.parse(await graph.exportProject(a.id)) as { project: { id: string } };
    assert.equal(exported.project.id, a.id);
    assert.ok(Array.isArray(JSON.parse(await graph.exportProject(a.id, "timeline"))));
    const invalidExport = await fetch(`${server.baseUrl}/api/projects/${a.id}/export?format=xml`);
    assert.equal(invalidExport.status, 400);

    const database = new DatabaseSync(join(root, a.id, "project.db"), { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const sourceColumns = database.prepare("PRAGMA table_info(intent_sources)").all().map((row) => row.name);
    const factColumns = database.prepare("PRAGMA table_info(facts)").all().map((row) => row.name);
    const intentColumns = database.prepare("PRAGMA table_info(intents)").all().map((row) => row.name);
    const hintColumns = database.prepare("PRAGMA table_info(hints)").all().map((row) => row.name);
    database.close();
    assert.deepEqual(tables, ["artifacts", "counters", "facts", "hints", "intent_sources", "intents", "project"]);
    assert.ok(sourceColumns.includes("source_description"));
    assert.equal(factColumns.includes("kind"), false);
    assert.ok(intentColumns.includes("custom_profile"));
    assert.ok(intentColumns.includes("custom_profile_digest"));
    assert.equal(intentColumns.includes("prompt_kind"), false);
    assert.equal(hintColumns.includes("kind"), false);
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
    from: [{ projectId: project.id, id: "origin", description: "start" }], description: "Remain open", createdBy: "test",
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

test("the Path Abstract API stores immutable structured descriptions by Fact", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-paths-"));
  const registry = new ProjectStoreRegistry(root);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "start", goal: "done", scope: "s" });
    const first = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: "origin", description: "start" }], description: "First step", createdBy: "test",
    });
    await graph.conclude(project.id, first.id, { description: "First result", artifact: null, concludedBy: "test" });
    await assert.rejects(
      graph.getPathAbstract(project.id, "f0001"),
      (error: unknown) => error instanceof GraphClientError && error.status === 404,
    );
    await graph.putPathAbstract(project.id, "f0001", {
      factRef: { projectId: project.id, id: "f0001", description: "First result" },
      pathOverview: "hand-written analysis", verifiedCore: ["Second result"],
    });
    const stored = await graph.getPathAbstract(project.id, "f0001");
    assert.equal(stored.pathOverview, "hand-written analysis");
    assert.deepEqual(stored.factRef, { projectId: project.id, id: "f0001", description: "First result" });
    await assert.rejects(
      graph.putPathAbstract(project.id, "f0001", {
        factRef: { projectId: project.id, id: "f0001", description: "wrong" },
        pathOverview: "bad", verifiedCore: ["bad"],
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400,
    );
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
