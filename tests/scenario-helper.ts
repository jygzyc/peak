import type { Graph, ProjectInput } from "../dist/graph/graph.js";
import type { TaskConfig } from "../dist/agent/types.js";
import { loadConfig } from "../dist/config/task-config.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { MetacogSupervisor } from "../dist/session/metacog-supervisor.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import { env } from "./helper.ts";

export function loadMockScenario(path: string): ReturnType<typeof loadConfig> {
  const loaded = loadConfig(path, undefined, { skipBaseline: true });
  loaded.config.workers = { mock: { kind: "mock" } };
  for (const profile of Object.values(loaded.config.profiles)) {
    if (profile) profile.runtime = { worker: "mock" };
  }
  return loaded;
}

export function createScenarioProject(
  graph: Graph & { sessionDir: string },
  loaded: ReturnType<typeof loadConfig>,
  workspaceDir = loaded.workspaceDir,
): ReturnType<Graph["createProject"]> {
  const input: ProjectInput = {
    session: loaded.session,
    name: loaded.config.task.name ?? loaded.session,
    target: loaded.config.task.target,
    goal: loaded.config.task.goal,
    worker: "mock",
    sessionDir: graph.sessionDir,
    workspaceDir,
    configPath: loaded.configPath,
    taskConfig: loaded.config,
  };
  return graph.createProject(input);
}

export function decisions(createIntents: unknown[] = [], concludeRun: unknown = null): string {
  return env("decisions", {
    createIntents,
    dispatchExplorerIntentIds: [],
    stopExplorerIntentIds: [],
    failIntents: [],
    consumeHints: [],
    concludeRun,
  });
}

export function attachScenario(
  graph: Graph,
  worker: MockWorker,
  config: TaskConfig,
  sessionId: string,
  bus: FederationBus,
  scope: string,
): SessionLoop {
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

export async function tickUntilCompleted(
  supervisor: GlobalSupervisor,
  projects: Array<{ graph: Graph; projectId: string }>,
  maxTicks = 40,
): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    await supervisor.tick();
    if (projects.every(({ graph, projectId }) =>
      graph.getProject(projectId)?.status === "completed")) return;
  }
}
