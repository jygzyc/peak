import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskConfig, WorkerConfig, SubagentProfile, MetacogTriggers } from "../dist/agent/types.js";
import { BUILTIN_PERMISSIONS, DEFAULT_METACOG_TRIGGERS } from "../dist/agent/types.js";
import { TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import type { Graph } from "../dist/graph/graph.js";

const TEMP_DIRS: string[] = [];
let sessionCounter = 0;

function builtinProfile(
  role: string,
  promptId: string,
  contract: string,
  graphView: string,
  extra?: { cooldownSteps?: number; triggers?: MetacogTriggers; concludeFile?: string },
): SubagentProfile {
  const profile: SubagentProfile = {
    role,
    runtime: { worker: "mock" },
    prompt: { file: `builtin:${promptId}` },
    context: { graphView: graphView as never },
    permissions: BUILTIN_PERMISSIONS[role] ?? [],
    output: { contract: contract as never },
  };
  if (extra?.cooldownSteps !== undefined) profile.cooldownSteps = extra.cooldownSteps;
  if (extra?.triggers) profile.triggers = extra.triggers;
  if (extra?.concludeFile) profile.prompt.concludeFile = `builtin:${extra.concludeFile}`;
  return profile;
}

export function minimalConfig(workerName = "mock"): TaskConfig {
  const workers: Record<string, WorkerConfig> = { [workerName]: { kind: "mock" } };
  return {
    task: { target: "test-target", goal: "test-goal" },
    profiles: {
      planner: builtinProfile("planner", "planner", "main_decision", "full", { cooldownSteps: 3 }),
      explorer: builtinProfile("explorer", "explorer", "candidate_fact", "focused", { concludeFile: "explorer-conclude" }),
      evaluator: builtinProfile("evaluator", "evaluator", "verdict", "evidence-only"),
      metacog: builtinProfile("metacog", "metacog", "hints", "summary", { triggers: { ...DEFAULT_METACOG_TRIGGERS } }),
    },
    workers,
    scheduler: { maxConcurrent: 2, refillPerTick: 1, workerLeaseMs: 300_000 },
    control: { mainProfile: "planner", metacogProfile: "metacog" },
  };
}

export function freshSetup(workerName = "mock") {
  return { graph: new TestGraph(), worker: new MockWorker(), config: minimalConfig(workerName) };
}

export function createProject(graph: Graph, overrides: Partial<{
  target: string;
  goal: string;
  session: string;
  workspaceDir: string;
  taskConfig: TaskConfig;
}> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "peak-"));
  TEMP_DIRS.push(dir);
  return graph.createProject({
    session: overrides.session ?? `s-${sessionCounter++}`,
    name: "test",
    target: overrides.target ?? "test-target",
    goal: overrides.goal ?? "test-goal",
    worker: "mock",
    sessionDir: dir,
    workspaceDir: overrides.workspaceDir ?? dir,
    configPath: "/tmp/task.json",
    taskConfig: overrides.taskConfig ?? minimalConfig(),
  });
}

export function env(kind: string, data: unknown): string {
  if (kind === "decisions" && data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.createIntents)) {
      data = {
        ...record,
        createIntents: record.createIntents.map((intent) => ({
          dispatchExplorer: true,
          ...(intent as object),
        })),
      };
    }
  }
  return JSON.stringify({ kind, data });
}

export function cleanupTempDirs(): void {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
