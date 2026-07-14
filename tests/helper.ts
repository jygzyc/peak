import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskConfig, WorkerConfig, SubagentProfile, MetacogTriggers } from "../dist/agent/types.js";
import { BUILTIN_PERMISSIONS, DEFAULT_METACOG_TRIGGERS } from "../dist/agent/types.js";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import type { Graph } from "../dist/graph/graph.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** Path to the builtin prompt markdown (src/agent/prompts). Exported so task-
 * shaped tests can point profiles at the real builtin prompts the way
 * minimalConfig() does. Use fileURLToPath, not URL.pathname (Windows-safe). */
export const PROMPTS_DIR = join(TEST_DIR, "..", "src", "agent", "prompts");
const TEMP_DIRS: string[] = [];
let sessionCounter = 0;

function builtinProfile(
  role: string,
  promptFile: string,
  contract: string,
  graphView: string,
  extra?: { cooldownSteps?: number; triggers?: MetacogTriggers; concludeFile?: string },
): SubagentProfile {
  const profile: SubagentProfile = {
    role,
    runtime: { worker: "mock" },
    prompt: { file: join(PROMPTS_DIR, promptFile) },
    context: { graphView: graphView as never },
    permissions: BUILTIN_PERMISSIONS[role] ?? [],
    output: { contract: contract as never },
  };
  if (extra?.cooldownSteps !== undefined) profile.cooldownSteps = extra.cooldownSteps;
  if (extra?.triggers) profile.triggers = extra.triggers;
  if (extra?.concludeFile) profile.prompt.concludeFile = join(PROMPTS_DIR, extra.concludeFile);
  return profile;
}

export function minimalConfig(workerName = "mock"): TaskConfig {
  const workers: Record<string, WorkerConfig> = { [workerName]: { kind: "mock" } };
  return {
    task: { target: "test-target", goal: "test-goal" },
    profiles: {
      planner: builtinProfile("planner", "planner.md", "main_decision", "full", { cooldownSteps: 3 }),
      explorer: builtinProfile("explorer", "explorer.md", "candidate_fact", "focused", { concludeFile: "explorer-conclude.md" }),
      evaluator: builtinProfile("evaluator", "evaluator.md", "verdict", "evidence-only"),
      metacog: builtinProfile("metacog", "metacog.md", "hints", "summary", { triggers: { ...DEFAULT_METACOG_TRIGGERS } }),
    },
    workers,
    scheduler: { maxConcurrent: 2, refillPerTick: 1, workerLeaseMs: 300_000 },
    control: { mainProfile: "planner", metacogProfile: "metacog" },
  };
}

export function freshSetup(workerName = "mock") {
  return { graph: new InMemoryGraph(), worker: new MockWorker(), config: minimalConfig(workerName) };
}

export function createProject(graph: Graph, overrides: Partial<{ target: string; goal: string; session: string }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "peak-"));
  TEMP_DIRS.push(dir);
  return graph.createProject({
    session: overrides.session ?? `s-${sessionCounter++}`,
    name: "test",
    target: overrides.target ?? "test-target",
    goal: overrides.goal ?? "test-goal",
    worker: "mock",
    sessionDir: dir,
    configPath: "/tmp/task.json",
    taskConfig: minimalConfig(),
  });
}

export function env(kind: string, data: unknown): string {
  return JSON.stringify({ kind, data });
}

export function cleanupTempDirs(): void {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
