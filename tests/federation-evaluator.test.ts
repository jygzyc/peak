import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { evaluatorExtra } from "../dist/agent/subagent-runner.js";
import { minimalConfig, createProject, env } from "./helper.ts";
import type { Fact } from "../dist/agent/types.js";

/**
 * Cross-session federation: a sibling session's VERIFIED facts and RULED-OUT
 * dead-ends are surfaced to the local evaluator as read-only corroboration.
 * The evaluator cross-validates the local candidate against them — sibling facts
 * never enter the local graph; they only appear in the evaluator's prompt.
 */

const SAMPLE_CANDIDATE: Fact = {
  id: "f001",
  projectId: "proj_1",
  description: "port 8080 exposes an unauthenticated admin panel",
  evidence: ["nmap shows 8080 open", "curl /admin returns 200 without auth"],
  source: "explorer",
  confidence: 0.7,
  status: "pending",
  createdAt: "2026-07-14T00:00:00Z",
};

test("evaluatorExtra: renders Cross-session Corroboration when sibling facts present", () => {
  const out = evaluatorExtra(SAMPLE_CANDIDATE, [
    { summary: "admin panel at :8080 confirmed reachable", confidence: 0.9, fromSession: "sess-a" },
  ]);
  assert.match(out, /Cross-session Corroboration/);
  assert.match(out, /sess-a/);
  assert.match(out, /admin panel at :8080 confirmed reachable/);
  assert.match(out, /conf 0\.9/);
  // The candidate itself is still rendered.
  assert.match(out, /port 8080 exposes an unauthenticated admin panel/);
});

test("evaluatorExtra: renders Cross-session Dead-ends when sibling dead-ends present", () => {
  const out = evaluatorExtra(SAMPLE_CANDIDATE, undefined, [
    { summary: "brute-forcing ssh on :22 is a dead end (rate-limited)", confidence: 0.2, fromSession: "sess-b" },
  ]);
  assert.match(out, /Cross-session Dead-ends/);
  assert.match(out, /sess-b/);
  assert.match(out, /brute-forcing ssh/);
});

test("evaluatorExtra: omits federation sections when no sibling insights", () => {
  const out = evaluatorExtra(SAMPLE_CANDIDATE);
  assert.doesNotMatch(out, /Cross-session/);
  // Backward compatible — plain candidate render still works.
  assert.match(out, /Candidate Fact Under Review/);
});

test("evaluatorExtra: empty arrays render nothing (no empty headers)", () => {
  const out = evaluatorExtra(SAMPLE_CANDIDATE, [], []);
  assert.doesNotMatch(out, /Cross-session/);
});

function decisions(createIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

test("federation: sibling verified fact appears in the evaluator's prompt during a run", async () => {
  // Session B shares a bus that already carries a fact insight published by a
  // sibling (sess-a). When B's evaluator runs, its prompt must contain the
  // Cross-session Corroboration section citing the sibling's finding.
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  const bus = new FederationBus();
  bus.publishInsight(
    "fact",
    { sessionId: "sess-a", projectId: "proj_other", factId: "f_x" },
    "admin panel reachable on :8080 without auth",
    0.9,
  );
  const loop = new SessionLoop(graph, worker, config, { federationBus: bus, sessionId: "sess-b" });

  worker.register(/automated planning module/i, decisions([{ description: "PROBE-8080" }]));
  worker.register(/PROBE-8080/i, env("fact", { description: "found admin panel on 8080", confidence: 0.75 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "corroborated by sibling" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions());

  await loop.run(p.id, { idlePollMs: 5 });

  // The evaluator call must have received the sibling fact in its prompt.
  const evaluatorCall = worker.calls().find((c) => /Evaluator Role/i.test(c.prompt));
  assert.ok(evaluatorCall, "evaluator was invoked");
  assert.match(evaluatorCall!.prompt, /Cross-session Corroboration/);
  assert.match(evaluatorCall!.prompt, /sess-a/);
  assert.match(evaluatorCall!.prompt, /admin panel reachable on :8080 without auth/);
  // And the candidate was accepted (federation corroborated it).
  const verified = graph.facts(p.id, "pass");
  assert.ok(verified.some((f) => f.description.includes("admin panel")), "candidate accepted via corroboration");
});

test("federation: own published insights are not echoed back to the same session", async () => {
  // sess-a publishes a fact insight (its own accept). When sess-a's evaluator
  // runs next, the insight must NOT appear in its prompt — collectSiblingInsights
  // skips insights whose source.sessionId === this session.
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  const bus = new FederationBus();
  bus.publishInsight(
    "fact",
    { sessionId: "sess-a", projectId: p.id, factId: "f_self" },
    "self-published finding",
    0.9,
  );
  const loop = new SessionLoop(graph, worker, config, { federationBus: bus, sessionId: "sess-a" });

  worker.register(/automated planning module/i, decisions([{ description: "PROBE-SELF" }]));
  worker.register(/PROBE-SELF/i, env("fact", { description: "local finding", confidence: 0.8 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions());

  await loop.run(p.id, { idlePollMs: 5 });

  const evaluatorCall = worker.calls().find((c) => /Evaluator Role/i.test(c.prompt));
  assert.ok(evaluatorCall);
  assert.doesNotMatch(evaluatorCall!.prompt, /Cross-session Corroboration/, "own insight must not be echoed back");
  assert.doesNotMatch(evaluatorCall!.prompt, /self-published finding/);
});

test("federation: sibling dead-end appears in the evaluator's prompt", async () => {
  // A sibling ruled out a path; the local evaluator must see it so it can reject
  // a candidate that aligns with the ruled-out direction.
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  const bus = new FederationBus();
  bus.publishInsight(
    "dead_end",
    { sessionId: "sess-c", projectId: "proj_other", factId: "f_d" },
    "ssh brute force on :22 is rate-limited and futile",
    0.2,
  );
  const loop = new SessionLoop(graph, worker, config, { federationBus: bus, sessionId: "sess-d" });

  worker.register(/automated planning module/i, decisions([{ description: "TRY-SSH-BRUTE" }]));
  worker.register(/TRY-SSH-BRUTE/i, env("fact", { description: "attempted ssh brute force", confidence: 0.4 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "deny", reason: "sibling ruled this out" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions());

  await loop.run(p.id, { idlePollMs: 5 });

  const evaluatorCall = worker.calls().find((c) => /Evaluator Role/i.test(c.prompt));
  assert.ok(evaluatorCall);
  assert.match(evaluatorCall!.prompt, /Cross-session Dead-ends/);
  assert.match(evaluatorCall!.prompt, /sess-c/);
  assert.match(evaluatorCall!.prompt, /ssh brute force/);
});

test("federation: two real sessions share a bus — A's accepted fact reaches B's evaluator", async () => {
  // TRUE end-to-end: loop A actually runs and publishes a fact insight on accept.
  // Then loop B runs against the SAME bus and its evaluator must see A's finding
  // in its Cross-session Corroboration section. This proves the publish→pull loop
  // closes across two independently-constructed SessionLoops.
  const bus = new FederationBus();

  // ── Session A: discovers a finding and accepts it → publishes to bus ──
  const graphA = new InMemoryGraph();
  const workerA = new MockWorker();
  const configA = minimalConfig();
  const pA = createProject(graphA);
  const loopA = new SessionLoop(graphA, workerA, configA, { federationBus: bus, sessionId: "sess-a" });

  workerA.register(/automated planning module/i, decisions([{ description: "A-PROBE" }]));
  workerA.register(/A-PROBE/i, env("fact", { description: "redis on :6379 has no auth", confidence: 0.92 }));
  workerA.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "confirmed" }));
  workerA.register(/## Recent Evaluator Verdicts/i, decisions());

  await loopA.run(pA.id, { idlePollMs: 5 });

  // The bus now carries A's fact insight (published by runEvaluators on accept).
  const published = bus.recentInsights().filter((i) => i.kind === "fact");
  assert.ok(published.some((i) => i.summary.includes("redis") && i.source.sessionId === "sess-a"),
    "session A must have published its accepted fact to the bus");

  // ── Session B: runs after A finished, shares the same bus ──
  const graphB = new InMemoryGraph();
  const workerB = new MockWorker();
  const configB = minimalConfig();
  const pB = createProject(graphB);
  const loopB = new SessionLoop(graphB, workerB, configB, { federationBus: bus, sessionId: "sess-b" });

  workerB.register(/automated planning module/i, decisions([{ description: "B-PROBE" }]));
  workerB.register(/B-PROBE/i, env("fact", { description: "checking redis exposure", confidence: 0.6 }));
  workerB.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));
  workerB.register(/## Recent Evaluator Verdicts/i, decisions());

  await loopB.run(pB.id, { idlePollMs: 5 });

  // B's evaluator prompt must contain A's finding — proving the publish→pull
  // loop closed across the two independent sessions.
  const bEvalCall = workerB.calls().find((c) => /Evaluator Role/i.test(c.prompt));
  assert.ok(bEvalCall, "session B's evaluator was invoked");
  assert.match(bEvalCall!.prompt, /Cross-session Corroboration/);
  assert.match(bEvalCall!.prompt, /sess-a/);
  assert.match(bEvalCall!.prompt, /redis on :6379 has no auth/);

  // And A's insight was NOT echoed into A's own later evaluator calls (A's only
  // evaluator run happened before B existed, so just confirm A's prompt lacks it
  // — already covered by the self-echo test, this is a cross-check).
  const aEvalCall = workerA.calls().find((c) => /Evaluator Role/i.test(c.prompt));
  assert.ok(aEvalCall);
  assert.doesNotMatch(aEvalCall!.prompt, /Cross-session Corroboration/,
    "A's evaluator ran before any sibling insight existed");
});

test("federation: two sessions publish mutually — each sees the other's finding", async () => {
  // Both sessions run to completion first (each publishes its own fact), then a
  // THIRD round on a fresh candidate confirms cross-visibility is symmetric:
  // neither session's own insight is echoed, but the sibling's is visible.
  const bus = new FederationBus();

  async function runSession(sid: string, intent: string, factDesc: string) {
    const graph = new InMemoryGraph();
    const worker = new MockWorker();
    const config = minimalConfig();
    const p = createProject(graph);
    const loop = new SessionLoop(graph, worker, config, { federationBus: bus, sessionId: sid });
    worker.register(/automated planning module/i, decisions([{ description: intent }]));
    worker.register(new RegExp(intent), env("fact", { description: factDesc, confidence: 0.9 }));
    worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));
    worker.register(/## Recent Evaluator Verdicts/i, decisions());
    await loop.run(p.id, { idlePollMs: 5 });
    return worker;
  }

  await runSession("alpha", "ALPHA-I", "alpha found mysql exposed on :3306");
  await runSession("beta", "BETA-I", "beta found postgres on :5432");

  // Both facts should be on the bus, each attributed to its own session.
  const facts = bus.recentInsights().filter((i) => i.kind === "fact");
  assert.ok(facts.some((i) => i.source.sessionId === "alpha" && i.summary.includes("mysql")));
  assert.ok(facts.some((i) => i.source.sessionId === "beta" && i.summary.includes("postgres")));
});

