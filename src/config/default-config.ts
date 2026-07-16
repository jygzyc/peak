/**
 * Default task configuration for peak.
 *
 * Provides a minimal runnable setup when task.json omits profile or worker
 * fields. Defaults avoid encoding domain-specific vulnerability-
 * hunting policy; role prompts are kept minimal so that task.json can override
 * them via `profiles.<id>.prompt.file`.
 */

import type { TaskConfig, SubagentProfile, GraphView, OutputContract, MetacogTriggers, SessionRole } from "../agent/types.js";
import { BUILTIN_ROLES, BUILTIN_PERMISSIONS, DEFAULT_METACOG_TRIGGERS } from "../agent/types.js";
import { builtinPromptSource, type BuiltinPromptId } from "../agent/prompts/index.js";

function builtinProfile(
  role: SessionRole,
  promptId: BuiltinPromptId,
  graphView: GraphView,
  contract: OutputContract,
  extra?: { cooldownSteps?: number; triggers?: MetacogTriggers; concludePromptId?: BuiltinPromptId },
): SubagentProfile {
  const profile: SubagentProfile = {
    role,
    runtime: { worker: "opencode" },
    prompt: { file: builtinPromptSource(promptId) },
    context: { graphView },
    permissions: BUILTIN_PERMISSIONS[role] ?? [],
    output: { contract },
  };
  if (extra?.cooldownSteps !== undefined) profile.cooldownSteps = extra.cooldownSteps;
  if (extra?.triggers) profile.triggers = extra.triggers;
  if (extra?.concludePromptId) profile.prompt.concludeFile = builtinPromptSource(extra.concludePromptId);
  return profile;
}

export function defaultConfig(): TaskConfig {
  return {
    task: { target: "", goal: "" },
    profiles: {
      planner: builtinProfile(BUILTIN_ROLES.planner, "planner", "full", "main_decision", { cooldownSteps: 3 }),
      explorer: builtinProfile(BUILTIN_ROLES.explorer, "explorer", "focused", "candidate_fact", { concludePromptId: "explorer-conclude" }),
      evaluator: builtinProfile(BUILTIN_ROLES.evaluator, "evaluator", "evidence-only", "verdict"),
      metacog: builtinProfile(BUILTIN_ROLES.metacog, "metacog", "summary", "hints", { triggers: { ...DEFAULT_METACOG_TRIGGERS } }),
    },
    workers: {
      opencode: { kind: "agent", backend: "opencode" },
    },
    // High concurrency by default: many small parallel intents (see planner
    // fan-out guidance) only parallelize when the scheduler does not throttle
    // dispatch to one explorer per step. maxConcurrent sets the slot pool;
    // refillPerTick == maxConcurrent so a single step can fan out to the full
    // pool instead of adding one explorer at a time.
    scheduler: { maxConcurrent: 10, refillPerTick: 10, workerLeaseMs: 300_000 },
    control: {
      mainProfile: "planner",
      explorerProfile: "explorer",
      evaluatorProfile: "evaluator",
      metacogProfile: "metacog",
    },
  };
}
