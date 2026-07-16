import { test } from "node:test";
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { env } from "./helper.ts";
import {
  attachScenario,
  createScenarioProject,
  decisions,
  loadMockScenario,
  tickUntilCompleted,
} from "./scenario-helper.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASE = join(ROOT, "examples", "two-app-vuln-analysis");

test("acceptance scenario 2: two different Apps use two sessions and evaluated federation", async () => {
  const senderLoaded = loadMockScenario(join(CASE, "tasks", "sender.json"));
  const receiverLoaded = loadMockScenario(join(CASE, "tasks", "receiver.json"));
  const senderGraph = new TestGraph();
  const receiverGraph = new TestGraph();
  const senderProject = createScenarioProject(senderGraph, senderLoaded);
  const receiverProject = createScenarioProject(receiverGraph, receiverLoaded);
  const senderWorker = new MockWorker();
  const receiverWorker = new MockWorker();

  senderWorker.register(/SENDER-BROADCAST/i, env("fact", {
    description: "sender leak: exported SyncActivity reads the private auth token and sends it in unprotected implicit com.peakdemo.AUTH_TOKEN broadcast",
    evidence: [
      "sender/AndroidManifest.xml: SyncActivity exported=true",
      "SyncActivity.kt: SharedPreferences auth/token -> Intent extra token -> sendBroadcast without package or permission",
    ],
    confidence: 0.99,
  }));
  senderWorker.register(/# Evaluator Role/i, (request) => {
    if (/FactBroadcast Under Review/i.test(request.prompt)) {
      return env("broadcast_assessment", {
        decision: /session_summary/i.test(request.prompt) ? "irrelevant" : "relevant",
        reason: "Receiver App evidence is cross-App context and is not copied into Sender truth",
      });
    }
    return env("verdict", { decision: "pass", reason: "sensitive source and unprotected implicit broadcast are directly evidenced" });
  });
  senderWorker.register(/# Metacog Role/i, env("hints", { hints: [] }));
  senderWorker.register(/automated planning module/i, () => {
    if (senderGraph.intents(senderProject.id).length === 0) {
      return decisions([{ description: "SENDER-BROADCAST: trace private token into cross-App Intent", from: [], dispatchExplorer: true }]);
    }
    const fact = senderGraph.facts(senderProject.id, "pass").find((item) => /sender leak:/i.test(item.description));
    return fact
      ? decisions([], { description: "Sender App analysis complete", from: [fact.id] })
      : decisions();
  });

  receiverWorker.register(/RECEIVER-ENTRY/i, env("fact", {
    description: "receiver entry: exported TokenReceiver accepts com.peakdemo.AUTH_TOKEN from any application",
    evidence: ["receiver/AndroidManifest.xml: exported TokenReceiver with AUTH_TOKEN intent-filter and no permission"],
    confidence: 0.97,
  }));
  receiverWorker.register(/RECEIVER-SINK/i, env("fact", {
    description: "receiver sink: broadcast token is stored as last_token and exposed by JavaScript bridge ReceiverToken.lastToken; requires proof that Sender emits a sensitive token",
    evidence: [
      "TokenReceiver.kt: token extra -> SharedPreferences inbox/last_token",
      "TokenWebViewActivity.kt: JavascriptInterface lastToken reads inbox/last_token",
    ],
    confidence: 0.94,
  }));
  receiverWorker.register(/CROSS-APP-COMBINE/i, env("fact", {
    description: "HIGH two-App token disclosure: Sender broadcasts its private auth token and Receiver exposes the received value to WebView JavaScript",
    evidence: [
      "local receiver parent Facts prove exported reception and JavaScript sink",
      "evaluated Sender FactBroadcast proves the missing sensitive upstream source",
    ],
    confidence: 0.99,
  }));
  receiverWorker.register(/# Evaluator Role/i, (request) => {
    if (/FactBroadcast Under Review/i.test(request.prompt)) {
      if (/session_summary/i.test(request.prompt)) {
        return env("broadcast_assessment", { decision: "irrelevant", reason: "summary cannot satisfy a Fact condition" });
      }
      const pending = receiverGraph.facts(receiverProject.id, "pending")
        .find((fact) => /receiver sink:/i.test(fact.description));
      if (pending && /sender leak:.*private auth token/i.test(request.prompt)) {
        return env("broadcast_assessment", {
          decision: "condition_satisfied",
          targetFactId: pending.id,
          reason: "evaluated Sender evidence proves the named sensitive upstream broadcast condition",
        });
      }
      return env("broadcast_assessment", { decision: "relevant", reason: "related external evidence" });
    }
    if (/receiver sink:/i.test(request.prompt)) {
      const upstreamProved = receiverGraph.events(receiverProject.id).some((event) =>
        event.type === "federation.broadcast_assessed"
        && event.payload.decision === "condition_satisfied");
      return upstreamProved
        ? env("verdict", { decision: "pass", reason: "local sink plus evaluated Sender source proves the cross-App path" })
        : env("verdict", {
            decision: "pending",
            reason: "Receiver sink is local, but the sensitive upstream Sender broadcast is not yet proved",
            requiredConditions: ["Sender App emits private auth token in unprotected AUTH_TOKEN broadcast"],
          });
    }
    return env("verdict", { decision: "pass", reason: "local Receiver App source evidence satisfies the gate" });
  });
  receiverWorker.register(/# Metacog Role/i, env("hints", { hints: [] }));
  receiverWorker.register(/automated planning module/i, () => {
    if (receiverGraph.intents(receiverProject.id).length === 0) {
      return decisions([
        { description: "RECEIVER-ENTRY: prove exported cross-App reception", from: [], dispatchExplorer: true },
        { description: "RECEIVER-SINK: trace token extra to WebView JavaScript impact", from: [], dispatchExplorer: true },
      ]);
    }
    const passed = receiverGraph.facts(receiverProject.id, "pass");
    const entry = passed.find((fact) => /receiver entry:/i.test(fact.description));
    const sink = passed.find((fact) => /receiver sink:/i.test(fact.description));
    const combinedIntent = receiverGraph.intents(receiverProject.id)
      .find((intent) => /CROSS-APP-COMBINE/i.test(intent.description));
    if (entry && sink && !combinedIntent) {
      return decisions([{
        description: "CROSS-APP-COMBINE: synthesize Receiver-local evidence with the evaluated Sender reference",
        from: [entry.id, sink.id],
        dispatchExplorer: true,
      }]);
    }
    const finding = passed.find((fact) => /HIGH two-App token disclosure/i.test(fact.description));
    return finding
      ? decisions([], { description: "Receiver App cross-App analysis complete", from: [finding.id] })
      : decisions();
  });

  const bus = new TestFederationBus();
  const scope = "two-app-vuln";
  const supervisor = new GlobalSupervisor({ federationBus: bus, globalMaxConcurrent: 2 });
  supervisor.register(
    senderLoaded.session,
    attachScenario(senderGraph, senderWorker, senderLoaded.config, senderLoaded.session, bus, scope),
    { projectId: senderProject.id, scope },
  );
  supervisor.register(
    receiverLoaded.session,
    attachScenario(receiverGraph, receiverWorker, receiverLoaded.config, receiverLoaded.session, bus, scope),
    { projectId: receiverProject.id, scope },
  );

  try {
    await tickUntilCompleted(supervisor, [
      { graph: senderGraph, projectId: senderProject.id },
      { graph: receiverGraph, projectId: receiverProject.id },
    ]);

    assert.equal(senderGraph.getProject(senderProject.id)?.status, "completed");
    assert.equal(receiverGraph.getProject(receiverProject.id)?.status, "completed");
    assert.notEqual(senderProject.workspaceDir, receiverProject.workspaceDir);
    assert.match(senderProject.workspaceDir, /apps[\\/]sender$/);
    assert.match(receiverProject.workspaceDir, /apps[\\/]receiver$/);
    assert.ok(receiverGraph.facts(receiverProject.id, "pass").some((fact) =>
      /HIGH two-App token disclosure/i.test(fact.description)));
    assert.equal(receiverGraph.facts(receiverProject.id).some((fact) =>
      /sender leak:/i.test(fact.description)), false, "external Sender Fact must not be copied into Receiver Graph");
    assert.ok(receiverGraph.events(receiverProject.id).some((event) =>
      event.type === "federation.broadcast_assessed"
      && event.payload.decision === "condition_satisfied"));
    const combined = receiverGraph.intents(receiverProject.id)
      .find((intent) => /CROSS-APP-COMBINE/i.test(intent.description));
    assert.equal(combined?.parentFactIds.length, 2);
    assert.ok(bus.recentInsights(50, scope).some((insight) => insight.source.sessionId === "app-sender"));
    assert.ok(bus.recentInsights(50, scope).some((insight) => insight.source.sessionId === "app-receiver"));
    assert.equal(bus.hasPendingDeliveries(scope), false);
    assert.equal(bus.allCursorsAtHead(scope), true);
  } finally {
    bus.close();
  }
});
