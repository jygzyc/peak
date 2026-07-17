import { test } from "node:test";
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { SqliteGraph } from "../dist/graph/sqlite-graph.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { loadConfig } from "../dist/config/task-config.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { MetacogSupervisor } from "../dist/session/metacog-supervisor.js";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import type { Graph, ProjectInput } from "../dist/graph/graph.js";
import type { TaskConfig } from "../dist/agent/types.js";
import { agentRecords, env } from "./helper.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASE_DIR = join(ROOT, "examples", "app-vuln-analysis");

function asMockConfig(path: string): ReturnType<typeof loadConfig> {
  const loaded = loadConfig(path, undefined, { skipBaseline: true });
  loaded.config.workers = { mock: { kind: "mock" } };
  for (const profile of Object.values(loaded.config.profiles)) {
    if (!profile) continue;
    profile.runtime = { worker: "mock" };
  }
  return loaded;
}

function createCaseProject(
  graph: Graph,
  loaded: ReturnType<typeof loadConfig>,
  sessionDir = (graph as Graph & { sessionDir?: string }).sessionDir ?? loaded.sessionDir,
): ReturnType<Graph["createProject"]> {
  const input: ProjectInput = {
    session: loaded.session,
    name: loaded.config.task.name ?? loaded.session,
    target: loaded.config.task.target,
    goal: loaded.config.task.goal,
    worker: "mock",
    sessionDir,
    workspaceDir: loaded.workspaceDir,
    configPath: loaded.configPath,
    taskConfig: loaded.config,
  };
  return graph.createProject(input);
}

function decisions(createIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", {
    createIntents,
    dispatchExplorerIntentIds: [],
    stopExplorerIntentIds: [],
    failIntents: [],
    consumeHints: [],
    concludeRun,
  });
}

function attachMetacog(
  graph: Graph,
  worker: MockWorker,
  config: TaskConfig,
  sessionId: string,
  bus: FederationBus,
): SessionLoop {
  const scope = config.federation?.scope ?? "app-vuln-demo";
  const loop = new SessionLoop(graph, worker, config, {
    federationBus: bus,
    sessionId,
    federationScope: scope,
  });
  const metacog = new MetacogSupervisor(
    graph,
    worker,
    config,
    undefined,
    { bus, sessionId, scope },
  );
  loop.setMetacog(metacog);
  return loop;
}

function registerEntrypointWorkers(
  worker: MockWorker,
  graph: Graph,
  projectId: string,
): void {
  worker.register(/ENTRY-SURFACE/i, env("fact", {
    description: "reachable attacker-controlled deep link: exported DeepLinkActivity accepts peakdemo://open url query input; plain host suffix guard accepts evil-example.com",
    evidence: [
      "AndroidManifest.xml: DeepLinkActivity android:exported=true with BROWSABLE peakdemo://open intent-filter",
      "DeepLinkActivity.kt: getQueryParameter(\"url\") -> Uri.parse(target)",
      "DeepLinkActivity.kt: uri.host?.endsWith(\"example.com\") accepts evil-example.com",
    ],
    confidence: 0.98,
  }));
  worker.register(/# Evaluator Role/i, (request) => {
    if (/FactBroadcast Under Review/i.test(request.prompt)) {
      return env("broadcast_assessment", {
        decision: /session_summary/i.test(request.prompt) ? "irrelevant" : "relevant",
        reason: "dataflow evidence is relevant context but remains an external reference",
      });
    }
    return env("verdict", {
      decision: "pass",
      reason: "Manifest, attacker control, and bypassable host guard are concretely evidenced",
      confidence: 0.98,
    });
  });
  worker.register(/# Metacog Role/i, env("hints", { hints: [] }));
  worker.register(/automated planning module/i, () => {
    if (graph.intents(projectId).length === 0) {
      return decisions([{
        description: "ENTRY-SURFACE: prove exported deep-link reachability, attacker control, and exact host guard semantics",
        from: [],
        priority: 1,
        dispatchExplorer: true,
      }]);
    }
    const passed = graph.facts(projectId, "pass");
    if (passed.length > 0 && graph.candidateFacts(projectId).length === 0) {
      return decisions([], {
        description: "Authorized fixture entry analysis complete: external reachability and suffix-guard bypass proven",
        from: passed.map((fact) => fact.id),
      });
    }
    return decisions();
  });
}

function registerDataflowWorkers(
  worker: MockWorker,
  graph: Graph,
  projectId: string,
): void {
  worker.register(/TRACE-WEBVIEW/i, env("fact", {
    description: "WebView dataflow: url query reaches WebView.loadUrl after a weak suffix guard; exploitability requires externally reachable attacker-controlled deep link",
    evidence: [
      "DeepLinkActivity.kt: target -> isTrusted(Uri.parse(target)) -> webView.loadUrl(target)",
      "DeepLinkActivity.kt: javaScriptEnabled=true before loadUrl",
    ],
    confidence: 0.9,
  }));
  worker.register(/TRACE-BRIDGE/i, env("fact", {
    description: "native impact: JavaScript interface PeakToken exposes TokenBridge.readAuthToken, which returns the private SharedPreferences auth token",
    evidence: [
      "DeepLinkActivity.kt: addJavascriptInterface(TokenBridge(this), \"PeakToken\")",
      "TokenBridge.kt: @JavascriptInterface readAuthToken -> SharedPreferences(auth).getString(token)",
    ],
    confidence: 0.96,
  }));
  worker.register(/COMBINE-CHAIN/i, env("fact", {
    description: "HIGH token disclosure chain proven: exported attacker deep link bypasses host suffix guard, loads attacker JavaScript, and exposes the private auth token through PeakToken.readAuthToken",
    evidence: [
      "parent facts prove local WebView flow and native token bridge",
      "evaluated federation condition proves exported attacker-controlled entry reachability",
    ],
    confidence: 0.99,
  }));
  worker.register(/# Evaluator Role/i, (request) => {
    if (/FactBroadcast Under Review/i.test(request.prompt)) {
      if (/session_summary/i.test(request.prompt)) {
        return env("broadcast_assessment", {
          decision: "irrelevant",
          reason: "summary is not a Fact and cannot satisfy a condition",
        });
      }
      const pending = graph.facts(projectId, "pending").find((fact) =>
        /WebView dataflow/i.test(fact.description));
      if (pending && /reachable attacker-controlled deep link/i.test(request.prompt)) {
        return env("broadcast_assessment", {
          decision: "condition_satisfied",
          targetFactId: pending.id,
          reason: "sibling evaluator verified the missing exported attacker-controlled entry condition",
        });
      }
      return env("broadcast_assessment", {
        decision: "relevant",
        reason: "related verified evidence retained as an external reference",
      });
    }

    if (/WebView dataflow:/i.test(request.prompt)) {
      const conditionArrived = graph.events(projectId).some((event) =>
        event.type === "federation.broadcast_assessed"
        && event.payload.decision === "condition_satisfied");
      return conditionArrived
        ? env("verdict", {
            decision: "pass",
            reason: "local source trace plus evaluated reachability broadcast proves the WebView path",
            confidence: 0.94,
          })
        : env("verdict", {
            decision: "pending",
            reason: "local sink trace is sound but exported attacker reachability is not yet locally available",
            requiredConditions: ["externally reachable attacker-controlled deep link"],
          });
    }
    return env("verdict", {
      decision: "pass",
      reason: "source-level bridge or combined chain evidence satisfies the evidence gate",
      confidence: 0.97,
    });
  });
  worker.register(/# Metacog Role/i, env("hints", { hints: [] }));
  worker.register(/automated planning module/i, () => {
    if (graph.intents(projectId).length === 0) {
      return decisions([
        {
          description: "TRACE-WEBVIEW: trace attacker URL through guard and WebView.loadUrl",
          from: [],
          priority: 1,
          dispatchExplorer: true,
        },
        {
          description: "TRACE-BRIDGE: trace JavaScript bridge to sensitive token impact",
          from: [],
          priority: 1,
          dispatchExplorer: true,
        },
      ]);
    }

    const passed = graph.facts(projectId, "pass");
    const webview = passed.find((fact) => /WebView dataflow:/i.test(fact.description));
    const bridge = passed.find((fact) => /native impact:/i.test(fact.description));
    const combinedIntent = graph.intents(projectId).find((intent) => /COMBINE-CHAIN/i.test(intent.description));
    if (webview && bridge && !combinedIntent) {
      return decisions([{
        description: "COMBINE-CHAIN: join reachable WebView flow and native bridge impact into the final finding",
        from: [webview.id, bridge.id],
        priority: 1,
        dispatchExplorer: true,
      }]);
    }

    const combined = passed.find((fact) => /HIGH token disclosure chain proven/i.test(fact.description));
    if (combined && graph.candidateFacts(projectId).length === 0) {
      return decisions([], {
        description: "Authorized fixture analysis complete: HIGH WebView-to-native token disclosure chain proven",
        from: [combined.id],
      });
    }
    return decisions();
  });
}

test("acceptance: dual-session App analysis converges through evaluated broadcasts", async () => {
  const entryLoaded = asMockConfig(join(CASE_DIR, "tasks", "entrypoints.json"));
  const dataLoaded = asMockConfig(join(CASE_DIR, "tasks", "dataflow.json"));
  const entryGraph = new TestGraph();
  const dataGraph = new TestGraph();
  const entryProject = createCaseProject(entryGraph, entryLoaded);
  const dataProject = createCaseProject(dataGraph, dataLoaded);
  const entryWorker = new MockWorker();
  const dataWorker = new MockWorker();
  registerEntrypointWorkers(entryWorker, entryGraph, entryProject.id);
  registerDataflowWorkers(dataWorker, dataGraph, dataProject.id);

  const bus = new TestFederationBus();
  const entryLoop = attachMetacog(entryGraph, entryWorker, entryLoaded.config, entryLoaded.session, bus);
  const dataLoop = attachMetacog(dataGraph, dataWorker, dataLoaded.config, dataLoaded.session, bus);
  const supervisor = new GlobalSupervisor({ federationBus: bus, globalMaxConcurrent: 2 });
  supervisor.register(entryLoaded.session, entryLoop, {
    projectId: entryProject.id,
    scope: "app-vuln-demo",
  });
  supervisor.register(dataLoaded.session, dataLoop, {
    projectId: dataProject.id,
    scope: "app-vuln-demo",
  });

  for (let tick = 0; tick < 30; tick += 1) {
    await supervisor.tick();
    if (entryGraph.getProject(entryProject.id)?.status === "completed"
      && dataGraph.getProject(dataProject.id)?.status === "completed") break;
  }

  assert.equal(entryGraph.getProject(entryProject.id)?.status, "completed");
  assert.equal(dataGraph.getProject(dataProject.id)?.status, "completed");
  assert.ok(entryGraph.facts(entryProject.id, "pass").some((fact) =>
    /reachable attacker-controlled deep link/i.test(fact.description)));
  assert.ok(dataGraph.facts(dataProject.id, "pass").some((fact) =>
    /HIGH token disclosure chain proven/i.test(fact.description)));
  assert.ok(dataGraph.events(dataProject.id).some((event) =>
    event.type === "federation.broadcast_assessed"
    && event.payload.decision === "condition_satisfied"));
  assert.ok(dataGraph.events(dataProject.id).some((event) =>
    event.type === "fact.reactivated"));

  const combinedIntent = dataGraph.intents(dataProject.id).find((intent) =>
    /COMBINE-CHAIN/i.test(intent.description));
  assert.ok(combinedIntent);
  assert.equal(combinedIntent!.parentFactIds.length, 2);
  assert.ok(combinedIntent!.parentFactIds.every((factId) =>
    dataGraph.getFact(dataProject.id, factId)?.status === "pass"));

  assert.equal(bus.hasPendingDeliveries("app-vuln-demo"), false);
  assert.equal(bus.allCursorsAtHead("app-vuln-demo"), true);
  assert.equal(bus.cursor(entryLoaded.session), bus.headSeq("app-vuln-demo"));
  assert.equal(bus.cursor(dataLoaded.session), bus.headSeq("app-vuln-demo"));

  const records = [...await agentRecords(entryProject), ...await agentRecords(dataProject)];
  const skillInjected = records
    .filter((record) => record.role === "planner" || record.role === "explorer")
    .every((record) => record.promptManifest?.components.some((component) => component.kind === "skill"));
  assert.equal(skillInjected, true, "planner/explorer runs must record the configured skill component");
  assert.ok((await agentRecords(dataProject)).every((record) =>
    typeof record.promptHash === "string" && record.promptHash.length === 64));

  bus.close();
});

test("acceptance: dual-session App analysis resumes after both graphs and FederationBus reopen", async () => {
  const entryLoaded = asMockConfig(join(CASE_DIR, "tasks", "entrypoints.json"));
  const dataLoaded = asMockConfig(join(CASE_DIR, "tasks", "dataflow.json"));
  const stateDir = mkdtempSync(join(tmpdir(), "peak-app-reopen-"));
  const entryDb = join(stateDir, "entry.db");
  const dataDb = join(stateDir, "data.db");
  const busDb = join(stateDir, "federation.db");

  let entryGraph = new SqliteGraph(entryDb);
  let dataGraph = new SqliteGraph(dataDb);
  const entryProject = createCaseProject(entryGraph, entryLoaded, join(stateDir, "entry"));
  const dataProject = createCaseProject(dataGraph, dataLoaded, join(stateDir, "data"));
  let bus = new FederationBus({ dbPath: busDb });

  const firstEntryWorker = new MockWorker();
  const firstDataWorker = new MockWorker();
  registerEntrypointWorkers(firstEntryWorker, entryGraph, entryProject.id);
  registerDataflowWorkers(firstDataWorker, dataGraph, dataProject.id);
  const firstSupervisor = new GlobalSupervisor({ federationBus: bus, globalMaxConcurrent: 2 });
  firstSupervisor.register(
    entryLoaded.session,
    attachMetacog(entryGraph, firstEntryWorker, entryLoaded.config, entryLoaded.session, bus),
    { projectId: entryProject.id, scope: "app-vuln-demo" },
  );
  firstSupervisor.register(
    dataLoaded.session,
    attachMetacog(dataGraph, firstDataWorker, dataLoaded.config, dataLoaded.session, bus),
    { projectId: dataProject.id, scope: "app-vuln-demo" },
  );

  await firstSupervisor.tick();
  assert.notEqual(dataGraph.getProject(dataProject.id)?.status, "completed");
  assert.ok(entryGraph.events(entryProject.id).length > 0);
  assert.ok(dataGraph.events(dataProject.id).length > 0);
  entryGraph.close();
  dataGraph.close();
  bus.close();

  entryGraph = new SqliteGraph(entryDb);
  dataGraph = new SqliteGraph(dataDb);
  bus = new FederationBus({ dbPath: busDb });
  const resumedEntryWorker = new MockWorker();
  const resumedDataWorker = new MockWorker();
  registerEntrypointWorkers(resumedEntryWorker, entryGraph, entryProject.id);
  registerDataflowWorkers(resumedDataWorker, dataGraph, dataProject.id);
  const resumedSupervisor = new GlobalSupervisor({ federationBus: bus, globalMaxConcurrent: 2 });
  resumedSupervisor.register(
    entryLoaded.session,
    attachMetacog(entryGraph, resumedEntryWorker, entryLoaded.config, entryLoaded.session, bus),
    { projectId: entryProject.id, scope: "app-vuln-demo" },
  );
  resumedSupervisor.register(
    dataLoaded.session,
    attachMetacog(dataGraph, resumedDataWorker, dataLoaded.config, dataLoaded.session, bus),
    { projectId: dataProject.id, scope: "app-vuln-demo" },
  );

  for (let tick = 0; tick < 30; tick += 1) {
    await resumedSupervisor.tick();
    if (entryGraph.getProject(entryProject.id)?.status === "completed"
      && dataGraph.getProject(dataProject.id)?.status === "completed") break;
  }

  assert.equal(entryGraph.getProject(entryProject.id)?.status, "completed");
  assert.equal(dataGraph.getProject(dataProject.id)?.status, "completed");
  assert.ok(dataGraph.facts(dataProject.id, "pass").some((fact) =>
    /HIGH token disclosure chain proven/i.test(fact.description)));
  assert.ok(dataGraph.events(dataProject.id).some((event) =>
    event.type === "federation.broadcast_assessed"
    && event.payload.decision === "condition_satisfied"));
  assert.equal(bus.hasPendingDeliveries("app-vuln-demo"), false);
  assert.equal(bus.allCursorsAtHead("app-vuln-demo"), true);
  assert.ok([...await agentRecords(entryProject), ...await agentRecords(dataProject)]
    .every((record) => record.status !== "running"));

  entryGraph.close();
  dataGraph.close();
  bus.close();
});
