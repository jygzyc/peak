/**
 * Regression tests for two session-loop exhaustion bugs:
 *   1. checkTermination must not complete while intents are still claimed
 *      (in-flight explorers) — runs were cut short while a worker was executing.
 *   2. maybeRunPlanner must re-plan on an ACCEPT verdict so the planner can
 *      chain a downstream trace intent from a verified entrypoint. Without
 *      this, the loop stopped after the first accept instead of exhausting the
 *      attack surface.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(ci: unknown[] = [], fi: unknown[] = [], cr: unknown = null) {
  return env("decisions", { createIntents: ci, failIntents: fi, consumeHints: [], concludeRun: cr });
}

test("exhaustion: planner chains a downstream trace intent after an accepted fact (re-plan on accept)", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph, { goal: "G" });

  // planner round 1: open an entrypoint-collection intent
  // planner round 2+: open a trace intent (once), then conclude once the trace is verified
  let traceOpened = false;
  let round = 0;
  worker.register(/automated planning module/i, () => {
    round++;
    if (round === 1) return decisions([{ description: "COLLECT-ENTRY", from: [], priority: 1 }]);
    const ci = traceOpened ? [] : [{ description: "TRACE-SINK", from: [], priority: 1 }];
    if (!traceOpened) traceOpened = true;
    const verifiedDescs = graph.facts(p.id, "pass").map((f) => f.description);
    const traceProven = verifiedDescs.some((d) => /sink/i.test(d));
    const cr = (traceOpened && traceProven && ci.length === 0) ? { description: "chain proven" } : null;
    return decisions(ci, [], cr);
  });
  worker.register(/COLLECT-ENTRY/i, env("fact", { description: "entrypoint: exported Activity", evidence: ["manifest"], confidence: 0.8 }));
  worker.register(/TRACE-SINK/i, env("fact", { description: "sink: controlled value reaches loadUrl", evidence: ["onCreate -> loadUrl"], confidence: 0.85 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "concrete" }));

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { idlePollMs: 5 });

  assert.equal(result.type, "completed");
  const descs = graph.facts(p.id, "pass").map((f) => f.description);
  assert.ok(descs.some((d) => /entrypoint/i.test(d)), "the entrypoint fact should be verified");
  assert.ok(descs.some((d) => /sink/i.test(d)), "the downstream trace fact should be verified (planner chained on accept)");
});

test("exhaustion: does NOT complete while an intent is still claimed (in-flight explorer)", async () => {
  // A worker that resolves slowly simulates an in-flight explorer whose claim
  // is still live when checkTermination first sees openIntents === 0.
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph, { goal: "G" });

  // planner: round 1 open the slow task; round 2+ conclude (no more work).
  let slowRound = 0;
  worker.register(/automated planning module/i, () => {
    slowRound++;
    if (slowRound === 1) return decisions([{ description: "SLOW-TASK", from: [], priority: 1 }]);
    return decisions([], [], { description: "done" });
  });
  // explorer resolves asynchronously; the intent is claimed while it runs
  worker.register(/SLOW-TASK/i, async () => {
    await new Promise((r) => setTimeout(r, 20));
    return env("fact", { description: "slow fact", evidence: ["e"], confidence: 0.9 });
  });
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { idlePollMs: 5 });

  // The run must complete normally (the claim is swept/resolved, not dropped)
  // and the slow explorer's fact must be verified — it was not cut short.
  assert.equal(result.type, "completed");
  const descs = graph.facts(p.id, "pass").map((f) => f.description);
  assert.ok(descs.some((d) => /slow fact/i.test(d)), "the in-flight explorer's fact should be verified, not dropped");
});
