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
const TASK = join(ROOT, "examples", "app-vuln-analysis", "tasks", "single-app.json");

test("acceptance scenario 1: one App is analyzed end-to-end in one session", async () => {
  const loaded = loadMockScenario(TASK);
  const graph = new TestGraph();
  const project = createScenarioProject(graph, loaded);
  const worker = new MockWorker();

  worker.register(/SINGLE-ENTRY/i, env("fact", {
    description: "single-app entry: exported BROWSABLE DeepLinkActivity accepts attacker-controlled url and evil-example.com bypasses the plain suffix guard",
    evidence: [
      "AndroidManifest.xml: exported=true and BROWSABLE peakdemo://open",
      "DeepLinkActivity.kt: getQueryParameter(url) and host.endsWith(example.com)",
    ],
    confidence: 0.98,
  }));
  worker.register(/SINGLE-SINK/i, env("fact", {
    description: "single-app sink: attacker page reaches JavaScript-enabled WebView and PeakToken.readAuthToken returns the private auth token",
    evidence: [
      "DeepLinkActivity.kt: javaScriptEnabled=true; addJavascriptInterface; loadUrl(target)",
      "TokenBridge.kt: @JavascriptInterface reads SharedPreferences auth/token",
    ],
    confidence: 0.98,
  }));
  worker.register(/SINGLE-COMBINE/i, env("fact", {
    description: "HIGH single-App token disclosure: the exported deep link loads attacker JavaScript that reads PeakToken.readAuthToken",
    evidence: ["ordered local parent Facts prove entry/guard and WebView/native impact"],
    confidence: 0.99,
  }));
  worker.register(/# Evaluator Role/i, env("verdict", {
    decision: "pass",
    reason: "repository-relative Manifest and Kotlin evidence satisfies entry, control, guard, sink and impact",
    confidence: 0.98,
  }));
  worker.register(/# Metacog Role/i, env("hints", { hints: [] }));
  worker.register(/automated planning module/i, () => {
    if (graph.intents(project.id).length === 0) {
      return decisions([
        { description: "SINGLE-ENTRY: prove external entry, attacker control and guard bypass", from: [], dispatchExplorer: true },
        { description: "SINGLE-SINK: prove WebView and native token impact", from: [], dispatchExplorer: true },
      ]);
    }
    const passed = graph.facts(project.id, "pass");
    const entry = passed.find((fact) => /single-app entry:/i.test(fact.description));
    const sink = passed.find((fact) => /single-app sink:/i.test(fact.description));
    const combinedIntent = graph.intents(project.id).find((intent) => /SINGLE-COMBINE/i.test(intent.description));
    if (entry && sink && !combinedIntent) {
      return decisions([{
        description: "SINGLE-COMBINE: synthesize the complete local vulnerability chain",
        from: [entry.id, sink.id],
        dispatchExplorer: true,
      }]);
    }
    const finding = passed.find((fact) => /HIGH single-App token disclosure/i.test(fact.description));
    return finding
      ? decisions([], { description: "Single App analysis complete", from: [finding.id] })
      : decisions();
  });

  const bus = new TestFederationBus();
  const scope = "single-app-vuln";
  const loop = attachScenario(graph, worker, loaded.config, loaded.session, bus, scope);
  const supervisor = new GlobalSupervisor({ federationBus: bus, globalMaxConcurrent: 2 });
  supervisor.register(loaded.session, loop, { projectId: project.id, scope });

  try {
    await tickUntilCompleted(supervisor, [{ graph, projectId: project.id }]);

    assert.equal(supervisor.listSessions().length, 1);
    assert.equal(graph.getProject(project.id)?.status, "completed");
    assert.ok(graph.facts(project.id, "pass").some((fact) =>
      /HIGH single-App token disclosure/i.test(fact.description)));
    const combined = graph.intents(project.id).find((intent) => /SINGLE-COMBINE/i.test(intent.description));
    assert.deepEqual(combined?.parentFactIds.length, 2);
    assert.ok(graph.activeEndFact(project.id));
    assert.ok((await agentRecords(project))
      .filter((record) => record.role === "planner" || record.role === "explorer")
      .every((record) => record.promptManifest?.components.some((component) => component.kind === "skill")));
    assert.equal(bus.hasPendingDeliveries(scope), false);
    assert.equal(bus.allCursorsAtHead(scope), true);
  } finally {
    bus.close();
  }
});
