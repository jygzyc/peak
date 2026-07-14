/**
 * Default task configuration for peak.
 *
 * Provides a minimal runnable setup when task.json omits profile, worker, or
 * workflow fields. Defaults avoid encoding domain-specific vulnerability-
 * hunting policy; role prompts are kept minimal so that task.json can override
 * them via `profiles.<id>.prompt.file`.
 */

import type { TaskConfig, SubagentProfile, GraphView, OutputContract, MetacogTriggers } from "../agent/types.js";
import { BUILTIN_ROLES, BUILTIN_PERMISSIONS, DEFAULT_METACOG_TRIGGERS } from "../agent/types.js";

function builtinProfile(
  role: string,
  promptFile: string,
  graphView: GraphView,
  contract: OutputContract,
  extra?: { cooldownSteps?: number; triggers?: MetacogTriggers; concludeFile?: string },
): SubagentProfile {
  const profile: SubagentProfile = {
    role,
    runtime: { worker: "opencode" },
    prompt: { file: promptFile },
    context: { graphView },
    permissions: BUILTIN_PERMISSIONS[role] ?? [],
    output: { contract },
  };
  if (extra?.cooldownSteps !== undefined) profile.cooldownSteps = extra.cooldownSteps;
  if (extra?.triggers) profile.triggers = extra.triggers;
  if (extra?.concludeFile) profile.prompt.concludeFile = extra.concludeFile;
  return profile;
}

export function defaultConfig(): TaskConfig {
  return {
    task: { target: "", goal: "" },
    profiles: {
      planner: builtinProfile(BUILTIN_ROLES.planner, "agent/prompts/planner.md", "full", "main_decision", { cooldownSteps: 3 }),
      explorer: builtinProfile(BUILTIN_ROLES.explorer, "agent/prompts/explorer.md", "focused", "candidate_fact", { concludeFile: "agent/prompts/explorer-conclude.md" }),
      evaluator: builtinProfile(BUILTIN_ROLES.evaluator, "agent/prompts/evaluator.md", "evidence-only", "verdict"),
      metacog: builtinProfile(BUILTIN_ROLES.metacog, "agent/prompts/metacog.md", "summary", "hints", { triggers: { ...DEFAULT_METACOG_TRIGGERS } }),
    },
    workers: {
      opencode: { kind: "agent", backend: "opencode" },
    },
    scheduler: { maxConcurrent: 3, refillPerTick: 1, workerLeaseMs: 300_000 },
    control: {
      mainProfile: "planner",
      metacogProfile: "metacog",
      metacogIntervalSeconds: DEFAULT_METACOG_TRIGGERS.everySeconds,
    },
  };
}
