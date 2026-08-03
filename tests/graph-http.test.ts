import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { customProfileDigest } from "../dist/config/custom-profile.js";
import { GraphClient, GraphClientError } from "../dist/graph/graph-client.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";
import { leafFacts } from "../dist/graph/types.js";
import { serveDashboard } from "../dist/ui/dashboard.js";

test("the optional UI composes without becoming a Graph Server dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-ui-"));
  const registry = new ProjectStoreRegistry(root);
  const server = new GraphHttpServer(registry, serveDashboard);
  await server.start();
  try {
    const response = await fetch(server.baseUrl);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="hint-form"/);
    assert.match(html, /Custom profile/);
    assert.doesNotMatch(html, /kind-filter|Prompt kind/);
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
        from: [{ projectId: a.id, factId: "origin", description: "origin A" }], description: "安".repeat(683), createdBy: "test",
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 400 && /2 KiB/.test(error.message),
    );
    const profile = { description: "Use for primary-source research.", prompt: "Collect primary evidence." };
    const intent = await graph.createIntent(a.id, {
      from: [{ projectId: a.id, factId: "origin", description: "origin A" }],
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
    const resultRef = { projectId: a.id, factId: concluded.fact.id, description: concluded.fact.description };
    await assert.rejects(
      graph.createIntent(a.id, {
        from: [{ projectId: a.id, factId: "origin", description: "origin A" }], description: "Use historical source", createdBy: "test",
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 409 && /not a current leaf/.test(error.message),
    );
    await assert.rejects(
      graph.complete(a.id, {
        from: [{ projectId: a.id, factId: "origin", description: "origin A" }], description: "Complete from history", completedBy: "test",
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 409 && /not a current leaf/.test(error.message),
    );
    const [resolved] = await graph.resolveFactRefs(b.id, [resultRef]);
    assert.equal(resolved?.fact.description, "Result summary");
    assert.equal(resolved?.fact.artifact?.readOnly, true);
    assert.equal(readFileSync(resolved!.fact.artifact!.inputPath, "utf8"), "full result\n");
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
    const unscopedFact = await graph.conclude(d.id, unscopedIntent.id, { description: "Reusable evidence", artifact: null, concludedBy: "test" });
    assert.equal(unscopedFact.fact.artifact, null);
    const [resolvedWithoutArtifact] = await graph.resolveFactRefs(e.id, [{
      projectId: d.id, factId: unscopedFact.fact.id, description: "Reusable evidence",
    }]);
    assert.equal(resolvedWithoutArtifact?.fact.artifact, null);
    await graph.createIntent(e.id, {
      from: [{ projectId: d.id, factId: unscopedFact.fact.id, description: "Reusable evidence" }], description: "Reuse sibling evidence", createdBy: "test",
    });
    const updateIntent = await graph.createIntent(d.id, {
      from: [{ projectId: d.id, factId: unscopedFact.fact.id, description: "Reusable evidence" }], description: "Advance reusable evidence", createdBy: "test",
    });
    await graph.conclude(d.id, updateIntent.id, { description: "Updated reusable evidence", artifact: null, concludedBy: "test" });
    await assert.rejects(
      graph.createIntent(e.id, {
        from: [{ projectId: d.id, factId: unscopedFact.fact.id, description: "Reusable evidence" }], description: "Use stale external evidence", createdBy: "test",
      }),
      (error: unknown) => error instanceof GraphClientError && error.status === 409 && /not a current leaf/.test(error.message),
    );
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
    const latePath = join(root, "late.md");
    writeFileSync(latePath, "late\n");
    const lateArtifact = await graph.uploadArtifact(b.id, latePath, "text/markdown");
    await assert.rejects(
      graph.conclude(b.id, open.id, { description: "late", artifact: lateArtifact, concludedBy: "test" }),
      (error: unknown) => error instanceof GraphClientError && error.status === 409,
    );
    await assert.rejects(graph.deleteProject(a.id), (error: unknown) => error instanceof GraphClientError && error.status === 409);

    const reopenProject = await graph.createProject({ title: "reopen", target: "reopen origin", goal: "reopen goal" });
    const beforeFeedback = await graph.createIntent(reopenProject.id, {
      from: [{ projectId: reopenProject.id, factId: "origin", description: "reopen origin" }], description: "Establish current state", createdBy: "test",
    });
    const beforeFeedbackFact = await graph.conclude(reopenProject.id, beforeFeedback.id, {
      description: "Current state before feedback", artifact: null, concludedBy: "test",
    });
    await graph.complete(reopenProject.id, {
      from: [{ projectId: reopenProject.id, factId: beforeFeedbackFact.fact.id, description: beforeFeedbackFact.fact.description }],
      description: "Initial goal proof", completedBy: "test",
    });
    const reopened = await graph.reopen(reopenProject.id, { description: "External correction", creator: "human:test" });
    const feedbackIntent = reopened.intents.find((item) => item.description === "External feedback")!;
    assert.deepEqual(feedbackIntent.from, [{
      projectId: reopenProject.id, factId: beforeFeedbackFact.fact.id, description: beforeFeedbackFact.fact.description,
    }]);
    assert.deepEqual(leafFacts(reopened).map((fact) => fact.description), ["External correction"]);
    const operations = readFileSync(join(root, a.id, "logs", "main.log"), "utf8").trim().split(/\r?\n/)
      .map((line) => JSON.parse(line) as { at: string; type: string });
    assert.ok(operations.some((event) => event.type === "intent_concluded"));
    assert.ok(operations.every((event) => /^\d{8}T\d{6}\.\d{3}$/.test(event.at)));
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
