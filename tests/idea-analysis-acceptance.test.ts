import { test } from "node:test";
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { agentRecords, env } from "./helper.ts";
import {
  attachScenario,
  createScenarioProject,
  decisions,
  loadMockScenario,
  tickUntilCompleted,
} from "./scenario-helper.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASK = join(ROOT, "examples", "idea-analysis", "task.json");

test("acceptance scenario 3: an idea is deeply analyzed before recommendation", async () => {
  const loaded = loadMockScenario(TASK);
  const graph = new TestGraph();
  const project = createScenarioProject(graph, loaded);
  const worker = new MockWorker();

  worker.register(/IDEA-PROBLEM/i, env("fact", {
    description: "problem/value evidence: inspectors duplicate paper notes into REST; pilot targets 30% less re-entry without more missing or duplicate inspections",
    evidence: ["idea-brief.md: current paper-to-REST workflow and explicit 30% guardrail metric"],
    confidence: 0.96,
  }));
  worker.register(/IDEA-FEASIBILITY/i, env("fact", {
    description: "technical feasibility: a bounded offline form/photo queue is feasible, but the existing API needs record versions, idempotency keys and explicit conflict review",
    evidence: ["idea-brief.md: two offline days; REST API has no conflict/version protocol; audit corrections required"],
    confidence: 0.9,
  }));
  worker.register(/IDEA-RISKS/i, env("fact", {
    description: "risk evidence: PII on lost devices, media backlog, auth expiry and three-engineer/twelve-week capacity make AI omission detection unsuitable for the first pilot",
    evidence: ["idea-brief.md: addresses/signatures/faces, two-day offline window, three engineers and twelve weeks"],
    confidence: 0.92,
  }));
  worker.register(/IDEA-SYNTHESIS/i, env("fact", {
    description: "GO with a bounded pilot: ship encrypted offline forms, idempotent sync and supervisor conflict review; defer AI; falsify value if re-entry time improves under 30% or data-quality guardrails regress",
    evidence: ["three ordered parent Facts cover user value, constrained architecture and ranked delivery/privacy risks"],
    confidence: 0.95,
  }));
  worker.register(/# Evaluator Role/i, env("verdict", {
    decision: "pass",
    reason: "claim cites the supplied brief, separates evidence from assumptions and states a falsifiable boundary",
    confidence: 0.94,
  }));
  worker.register(/# Metacog Role/i, env("hints", { hints: [] }));
  worker.register(/automated planning module/i, () => {
    if (graph.intents(project.id).length === 0) {
      return decisions([
        { description: "IDEA-PROBLEM: validate user problem, value hypothesis and metric", from: [], dispatchExplorer: true },
        { description: "IDEA-FEASIBILITY: test architecture against offline and API constraints", from: [], dispatchExplorer: true },
        { description: "IDEA-RISKS: rank privacy, delivery and adoption uncertainty", from: [], dispatchExplorer: true },
      ]);
    }
    const passed = graph.facts(project.id, "pass");
    const problem = passed.find((fact) => /problem\/value evidence:/i.test(fact.description));
    const feasibility = passed.find((fact) => /technical feasibility:/i.test(fact.description));
    const risks = passed.find((fact) => /risk evidence:/i.test(fact.description));
    const synthesisIntent = graph.intents(project.id).find((intent) => /IDEA-SYNTHESIS/i.test(intent.description));
    if (problem && feasibility && risks && !synthesisIntent) {
      return decisions([{
        description: "IDEA-SYNTHESIS: produce a bounded recommendation and falsifiable pilot",
        from: [problem.id, feasibility.id, risks.id],
        dispatchExplorer: true,
      }]);
    }
    const recommendation = passed.find((fact) => /GO with a bounded pilot:/i.test(fact.description));
    return recommendation
      ? decisions([], { description: "Idea deep analysis complete: bounded GO recommendation", from: [recommendation.id] })
      : decisions();
  });

  const bus = new TestFederationBus();
  const scope = "idea-deep-analysis";
  const supervisor = new GlobalSupervisor({ federationBus: bus, globalMaxConcurrent: 3 });
  supervisor.register(
    loaded.session,
    attachScenario(graph, worker, loaded.config, loaded.session, bus, scope),
    { projectId: project.id, scope },
  );

  try {
    await tickUntilCompleted(supervisor, [{ graph, projectId: project.id }]);

    assert.equal(graph.getProject(project.id)?.status, "completed");
    const synthesis = graph.intents(project.id).find((intent) => /IDEA-SYNTHESIS/i.test(intent.description));
    assert.equal(synthesis?.parentFactIds.length, 3);
    assert.ok(synthesis?.parentFactIds.every((id) => graph.getFact(project.id, id)?.status === "pass"));
    const recommendation = graph.facts(project.id, "pass").find((fact) => /GO with a bounded pilot:/i.test(fact.description));
    assert.ok(recommendation);
    assert.match(recommendation!.description, /idempotent sync/i);
    assert.match(recommendation!.description, /under 30%|guardrails regress/i);
    assert.ok(graph.activeEndFact(project.id)?.fromFactIds.includes(recommendation!.id));
    const records = await agentRecords(project);
    assert.ok(records
      .filter((record) => record.role === "planner" || record.role === "explorer")
      .every((record) => {
        const kinds = new Set(record.promptManifest?.components.map((component) => component.kind));
        return kinds.has("knowledge") && kinds.has("rule") && kinds.has("skill");
      }));
  } finally {
    bus.close();
  }
});
