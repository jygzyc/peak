import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { HttpServer } from "../dist/server/http-server.js";
import { HttpSessionGraphReader } from "../dist/agent/context-builder.js";
import { ServerSessionGraphReader } from "../dist/server/session-graph-reader.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[]) {
  return env("decisions", {
    createIntents: createIntents.map((intent) => ({ dispatchExplorer: true, ...(intent as object) })),
    failIntents: [], consumeHints: [], concludeRun: null,
  });
}

async function startServer(graph: TestGraph): Promise<{ server: HttpServer; base: string }> {
  const server = new HttpServer();
  const projects = graph.listProjects();
  assert.ok(projects.length <= 1, "one HTTP session binding requires one session-local graph");
  if (projects[0]) {
    server.registerSession({ sessionId: projects[0].session, projectId: projects[0].id, graph });
  }
  await server.start({ port: 0 });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

function post(url: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("http-server: POST /api/sessions returns the registered session list", async () => {
  const graphA = new TestGraph();
  const graphB = new TestGraph();
  const projectA = createProject(graphA, { session: "s1" });
  const projectB = createProject(graphB, { session: "s2" });
  const server = new HttpServer();
  server.registerSession({
    sessionId: "s1", projectId: projectA.id, graph: graphA,
  });
  server.registerSession({
    sessionId: "s2", projectId: projectB.id, graph: graphB,
  });
  await server.start({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const resp = await post(`${base}/api/sessions`);
    const projects = await resp.json();
    assert.equal(projects.length, 2);
    assert.equal((await post(`${base}/api/projects`)).status, 404);
    assert.equal((await fetch(`${base}/api/sessions`)).status, 405);
  } finally { await server.stop(); }
});

test("http-server: GET / serves dashboard HTML", async () => {
  const graph = new TestGraph();
  const { server, base } = await startServer(graph);
  try {
    const resp = await fetch(`${base}/`);
    const html = await resp.text();
    assert.ok(html.includes("<title>peak Dashboard</title>"));
    assert.match(resp.headers.get("content-security-policy") ?? "", /object-src 'none'/);
    assert.match(html, /fetch\('\/api\/sessions'/);
    assert.match(html, /safeClass\(f\.status\)/);
    assert.match(html, /esc\(f\.description\)/);
  } finally { await server.stop(); }
});

test("http-server: POST /api/sessions/:id/directives injects directive", async () => {
  const graph = new TestGraph();
  const p = createProject(graph, { session: "s1" });
  const { server, base } = await startServer(graph);
  try {
    const resp = await fetch(`${base}/api/sessions/s1/directives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "hint", payload: "check auth" }),
    });
    const dir = await resp.json();
    assert.equal(dir.kind, "hint");
    assert.equal(dir.payload, "check auth");
    assert.equal(graph.unconsumedDirectives(p.id).length, 1);
  } finally { await server.stop(); }
});

test("http-server: POST /api/sessions/:id returns full detail", async () => {
  const graph = new TestGraph();
  const p = createProject(graph, { session: "s1" });
  graph.addFact(p.id, { description: "test fact", source: "explorer", confidence: 0.9 });
  graph.addIntent(p.id, { description: "do work", creator: "planner" });
  const { server, base } = await startServer(graph);
  try {
    const resp = await post(`${base}/api/sessions/s1`);
    const data = await resp.json();
    assert.equal(data.facts.length, 1);
    assert.equal(data.intents.length, 1);
    assert.ok(data.progress);
  } finally { await server.stop(); }
});

test("http-server: one server isolates sessions and matches the local snapshot reader", async () => {
  const graphA = new TestGraph();
  const graphB = new TestGraph();
  const projectA = createProject(graphA, { session: "unified-a" });
  const projectB = createProject(graphB, { session: "unified-b" });
  const factA = graphA.addFact(projectA.id, { description: "only session A", source: "explorer" });
  graphA.resolveFact(projectA.id, factA.id, { decision: "pass", reason: "verified" });
  const factB = graphB.addFact(projectB.id, { description: "only session B", source: "explorer" });
  graphB.resolveFact(projectB.id, factB.id, { decision: "pass", reason: "verified" });

  const server = new HttpServer();
  server.registerSession({
    sessionId: "unified-a", graph: graphA, projectId: projectA.id,
  });
  server.registerSession({
    sessionId: "unified-b", graph: graphB, projectId: projectB.id,
  });
  await server.start({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const sessions = await (await post(`${base}/api/sessions`)).json() as Array<{ sessionId: string }>;
    assert.deepEqual(sessions.map((item) => item.sessionId), ["unified-a", "unified-b"]);

    const local = await new ServerSessionGraphReader(graphA).readSnapshot({
      sessionId: "unified-a", profileId: "planner", projectId: projectA.id, spec: { graphView: "full" },
    });
    const remote = await new HttpSessionGraphReader(base).readSnapshot({
      sessionId: "unified-a", profileId: "planner", projectId: projectA.id, spec: { graphView: "full" },
    });
    assert.equal(remote.contentHash, local.contentHash);
    assert.equal(remote.content, local.content);
    assert.match(remote.content, /only session A/);
    assert.doesNotMatch(remote.content, /only session B/);

    const intents = await (await post(`${base}/api/sessions/unified-b/intents`)).json() as unknown[];
    assert.deepEqual(intents, []);
  } finally {
    await server.stop();
  }
});

test("http-server: graph snapshots are role-scoped JSON, not direct database access", async () => {
  const graph = new TestGraph();
  const config = minimalConfig();
  config.profiles.explorer.permissions = ["handle_intent", "write_candidate_fact"];
  const project = createProject(graph, { session: "permission-session", taskConfig: config });
  const server = new HttpServer();
  server.registerSession({
    sessionId: project.session,
    projectId: project.id,
    graph,
  });
  await server.start({ port: 0 });
  const endpoint = `${server.baseUrl}/api/sessions/${project.session}/graph/snapshot`;
  try {
    const scoped = await post(endpoint, {
      projectId: project.id,
      profileId: "explorer",
      spec: { graphView: "focused" },
    });
    assert.equal(scoped.status, 200);
    assert.equal((await scoped.json()).view, config.profiles.explorer.context.graphView);

    const unknown = await post(endpoint, {
      projectId: project.id,
      profileId: "unknown",
      spec: { graphView: "summary" },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await server.stop();
  }
});

test("http-server: task-group read model exposes generation, membership, and broadcast watermarks", async () => {
  const graphA = new TestGraph();
  const graphB = new TestGraph();
  const projectA = createProject(graphA, { session: "group-a" });
  const projectB = createProject(graphB, { session: "group-b" });
  graphA.createEndFact(projectA.id, "session A is ready", []);
  const bus = new TestFederationBus();
  bus.registerExpectedSessions("analysis-group", ["group-a", "group-b"]);
  bus.registerSession("group-a", "analysis-group", projectA.id);
  bus.registerSession("group-b", "analysis-group", projectB.id);
  const server = new HttpServer(bus);
  server.registerSession({
    sessionId: "group-a", graph: graphA, projectId: projectA.id, taskGroupScope: "analysis-group",
  });
  server.registerSession({
    sessionId: "group-b", graph: graphB, projectId: projectB.id, taskGroupScope: "analysis-group",
  });
  await server.start({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const groups = await (await post(`${base}/api/task-groups`)).json() as Array<{
      scope: string; generation: number; headSeq: number; members: unknown[];
    }>;
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.scope, "analysis-group");
    assert.equal(groups[0]?.generation, 1);
    assert.equal(groups[0]?.headSeq, 0);
    assert.equal(groups[0]?.members.length, 2);

    const sessions = await (await post(`${base}/api/sessions`)).json() as Array<{
      sessionId: string; taskGroup: { scope: string; memberStatus: string };
    }>;
    assert.ok(sessions.every((session) => session.taskGroup.scope === "analysis-group"));
    assert.ok(sessions.every((session) => session.taskGroup.memberStatus === "active"));
    const endFacts = await (await post(`${base}/api/sessions/group-a/end-facts`)).json() as Array<{
      description: string;
    }>;
    assert.equal(endFacts[0]?.description, "session A is ready");
  } finally {
    await server.stop();
    bus.close();
  }
});

test("http-server: control endpoints require the configured bearer token", async () => {
  const graph = new TestGraph();
  const project = createProject(graph, { session: "secured" });
  const server = new HttpServer();
  server.registerSession({
    sessionId: "secured", projectId: project.id, graph,
  });
  await server.start({ port: 0, token: "test-secret" });
  const endpoint = `http://127.0.0.1:${server.port}/api/sessions/secured/directives`;
  try {
    const denied = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "hint", payload: "denied" }),
    });
    assert.equal(denied.status, 401);
    assert.equal(graph.unconsumedDirectives(project.id).length, 0);

    const allowed = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-secret" },
      body: JSON.stringify({ kind: "hint", payload: "allowed" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(graph.unconsumedDirectives(project.id).length, 1);
  } finally {
    await server.stop();
  }
});

test("http-server: non-loopback bindings require an explicit token", async () => {
  const server = new HttpServer();
  await assert.rejects(
    server.start({ host: "0.0.0.0", port: 0 }),
    /requires a token/,
  );
});

test("http-server: bind failures reject and leave the server reusable", async () => {
  const first = new HttpServer();
  const second = new HttpServer();
  await first.start({ port: 0 });
  try {
    await assert.rejects(
      second.start({ port: first.port }),
      /EADDRINUSE/,
    );
    assert.equal(second.port, 0);
    await second.start({ port: 0 });
    assert.ok(second.port > 0);
  } finally {
    await second.stop();
    await first.stop();
  }
});

test("http-server: duplicate start is rejected without replacing the listener", async () => {
  const server = new HttpServer();
  await server.start({ port: 0 });
  const port = server.port;
  try {
    await assert.rejects(server.start({ port: 0 }), /already started/);
    assert.equal(server.port, port);
  } finally {
    await server.stop();
  }
  assert.equal(server.port, 0);
});

test("http-server: event API is POST-only", async () => {
  const graph = new TestGraph();
  const project = createProject(graph, { session: "streamed" });
  const server = new HttpServer();
  server.registerSession({
    sessionId: "streamed", projectId: project.id, graph,
  });
  await server.start({ port: 0 });
  try {
    const endpoint = `http://127.0.0.1:${server.port}/api/sessions/streamed/events`;
    assert.equal((await fetch(endpoint)).status, 405);
    assert.equal((await post(endpoint)).status, 200);
  } finally {
    await server.stop();
  }
});

test("sessionLoop: multiple intents resolve to accepted facts", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  let jobsOpened = false;
  worker.register(/automated planning module/i, () => {
    if (!jobsOpened) { jobsOpened = true; return decisions([{ description: "JOB-ALPHA" }, { description: "JOB-BETA" }]); }
    return env("decisions", { createIntents: [], failIntents: [], consumeHints: [], concludeRun: { description: "done" } });
  });
  worker.register(/JOB-ALPHA/i, env("fact", { description: "alpha done", confidence: 0.9 }));
  worker.register(/JOB-BETA/i, env("fact", { description: "beta done", confidence: 0.9 }));
  worker.register(/Evaluator Role|Candidate Fact Under Review/i, env("verdict", { decision: "pass", reason: "ok" }));
  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 5 });
  const accepted = graph.facts(p.id, "pass");
  assert.ok(accepted.length >= 2, `expected >= 2 accepted facts, got ${accepted.length}`);
});
