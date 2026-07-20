/**
 * Default task configuration for peak.
 *
 * Provides the native four roles and the OpenCode worker used when a task does
 * not select a reusable Agent bundle. Domain behavior belongs in Agent files.
 */

import type { TaskConfig, SubagentProfile, GraphView, OutputContract, SessionRole } from "../agent/types.js";
import { BUILTIN_ROLES, BUILTIN_PERMISSIONS } from "../agent/types.js";
import { builtinPromptSource, type BuiltinPromptId } from "../agent/prompts/index.js";

function builtinProfile(
  role: SessionRole,
  promptId: BuiltinPromptId,
  graphView: GraphView,
  contract: OutputContract,
  extra?: { cooldownSteps?: number },
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
  return profile;
}

export function defaultConfig(): TaskConfig {
  return {
    task: { target: "", goal: "" },
    profiles: {
      planner: builtinProfile(BUILTIN_ROLES.planner, "planner", "full", "main_decision", { cooldownSteps: 3 }),
      explorer: builtinProfile(BUILTIN_ROLES.explorer, "explorer", "focused", "candidate_fact"),
      evaluator: builtinProfile(BUILTIN_ROLES.evaluator, "evaluator", "evidence-only", "verdict"),
      metacog: builtinProfile(BUILTIN_ROLES.metacog, "metacog", "summary", "hints"),
    },
    workers: {
      opencode: { type: "opencode" },
    },
    // High concurrency by default: many small parallel intents (see planner
    // fan-out guidance) only parallelize when the scheduler does not throttle
    // dispatch to one explorer per step. maxConcurrent sets the slot pool;
    // refillPerTick == maxConcurrent so a single step can fan out to the full
    // pool instead of adding one explorer at a time.
    scheduler: { maxConcurrent: 10, refillPerTick: 10 },
  };
}
