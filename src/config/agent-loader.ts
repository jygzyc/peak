/**
 * Agent loader — injects reusable role configs from ~/.peak/agents/ into the
 * four builtin profile slots (planner/explorer/evaluator/metacog).
 *
 * An agent file is a PATCH over a builtin profile, not a standalone profile:
 * it declares which slot it targets and which fields to override. Fields it
 * omits keep the builtin default. This preserves the graph-generation +
 * blackboard architecture (SessionLoop still only knows the four builtin slots)
 * while letting users customize each role without editing task.json.
 *
 * Agent files may also carry a `workers` map (worker definitions the role
 * brings with it), merged into the task's workers (task-level wins on conflict).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SubagentProfile,
  BuiltinProfiles,
  WorkerConfig,
  WorkerName,
  Permission,
  RuntimeSpec,
  PromptSpec,
  ContextSpec,
  GraphView,
  OutputContract,
  MetacogTriggers,
  RetryPolicy,
} from "../agent/types.js";
import { agentFile, assertConfigEntryName } from "./peak-home.js";
import { BUILTIN_PERMISSIONS } from "../agent/types.js";
import { resolvePromptPaths } from "./prompt-loader.js";

export const BUILTIN_SLOTS = ["planner", "explorer", "evaluator", "metacog"] as const;
export type BuiltinSlot = (typeof BUILTIN_SLOTS)[number];

/** Raw shape of an agent JSON file on disk. */
export interface AgentFile {
  /** Which builtin profile slot this agent patches. */
  slot: string;
  runtime?: Partial<RuntimeSpec>;
  prompt?: Partial<PromptSpec>;
  context?: Partial<{ graphView: GraphView } & Omit<ContextSpec, "graphView">>;
  permissions?: Permission[];
  output?: Partial<{ contract: OutputContract }>;
  maxActive?: number;
  cooldownSteps?: number;
  triggers?: MetacogTriggers;
  intervalSeconds?: number;
  maxOutputTokens?: number;
  retry?: RetryPolicy;
  /** Worker definitions this role brings; merged into the task workers. */
  workers?: Record<WorkerName, WorkerConfig>;
}

export interface LoadedAgent {
  name: string;
  slot: BuiltinSlot;
  file: AgentFile;
}

export interface InjectionOptions {
  /** Override the agents directory (testing). When set, agentFile() is bypassed. */
  agentsDir?: string;
}

/**
 * Load and validate a single agent file by name. Throws if the file is missing,
 * not an object, or declares an invalid slot.
 */
export function loadAgent(name: string, opts: InjectionOptions = {}): LoadedAgent {
  assertConfigEntryName(name, "agent");
  const path = opts.agentsDir ? join(opts.agentsDir, `${name}.json`) : agentFile(name);
  if (!existsSync(path)) {
    throw new Error(`agent config not found: ${name} (looked for ${path})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`agent config "${name}" is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`agent config "${name}" must be a JSON object`);
  }
  const unknown = Object.keys(parsed).find((key) => ![
    "slot", "runtime", "prompt", "context", "permissions", "output",
    "maxActive", "cooldownSteps", "triggers", "intervalSeconds",
    "maxOutputTokens", "retry", "workers",
  ].includes(key));
  if (unknown) throw new Error(`agent config "${name}" contains unknown field "${unknown}"`);
  const file = parsed as AgentFile;
  if (file.prompt) file.prompt = resolvePromptPaths(file.prompt, dirname(path));
  if (!file.slot || typeof file.slot !== "string") {
    throw new Error(`agent config "${name}" must declare a string \`slot\``);
  }
  if (!BUILTIN_SLOTS.includes(file.slot as BuiltinSlot)) {
    throw new Error(
      `agent config "${name}" has invalid slot "${file.slot}"; must be one of: ${BUILTIN_SLOTS.join(", ")}`,
    );
  }
  return { name, slot: file.slot as BuiltinSlot, file };
}

/**
 * Deep-merge an agent patch onto a base profile. The agent overrides only the
 * fields it declares; omitted fields keep the base value. `permissions` and
 * `output.contract` are replaced wholesale when declared (not concatenated),
 * so an agent can narrow a builtin's capabilities.
 */
export function applyAgentPatch(base: SubagentProfile, agent: AgentFile): SubagentProfile {
  if (agent.permissions) {
    const allowed = new Set(BUILTIN_PERMISSIONS[base.role]);
    const forbidden = agent.permissions.filter((permission) => !allowed.has(permission));
    if (forbidden.length > 0) {
      throw new Error(
        `agent slot "${base.role}" cannot declare permissions: ${forbidden.join(", ")}`,
      );
    }
  }
  if (agent.output?.contract) {
    const allowedContracts: Record<SubagentProfile["role"], OutputContract[]> = {
      planner: ["main_decision"],
      explorer: ["candidate_fact"],
      evaluator: ["verdict"],
      metacog: ["hints", "stop"],
    };
    if (!allowedContracts[base.role].includes(agent.output.contract)) {
      throw new Error(
        `agent slot "${base.role}" cannot use output contract "${agent.output.contract}"`,
      );
    }
  }
  const merged: SubagentProfile = {
    role: base.role,
    runtime: mergeRuntime(base.runtime, agent.runtime),
    prompt: mergePrompt(base.prompt, agent.prompt),
    context: mergeContext(base.context, agent.context),
    permissions: agent.permissions ?? base.permissions,
    output: agent.output ? { contract: agent.output.contract ?? base.output.contract } : base.output,
  };
  // Optional numeric fields: agent value wins when declared, else base.
  for (const key of ["maxActive", "cooldownSteps", "intervalSeconds", "maxOutputTokens"] as const) {
    const v = agent[key];
    if (typeof v === "number") merged[key] = v;
    else if (base[key] !== undefined) merged[key] = base[key];
  }
  if (agent.triggers) merged.triggers = agent.triggers;
  else if (base.triggers) merged.triggers = base.triggers;
  if (agent.retry) merged.retry = { ...base.retry, ...agent.retry };
  else if (base.retry) merged.retry = base.retry;
  return merged;
}

function mergeRuntime(base: RuntimeSpec, patch?: Partial<RuntimeSpec>): RuntimeSpec {
  if (!patch) return base;
  return {
    worker: patch.worker ?? base.worker,
    ...(patch.workers ? { workers: patch.workers } : base.workers ? { workers: base.workers } : {}),
    ...(patch.model ? { model: patch.model } : base.model ? { model: base.model } : {}),
    ...(patch.provider ? { provider: patch.provider } : base.provider ? { provider: base.provider } : {}),
  };
}

function mergePrompt(base: PromptSpec, patch?: Partial<PromptSpec>): PromptSpec {
  if (!patch) return base;
  return {
    file: patch.file ?? base.file,
    ...(patch.rules ? { rules: patch.rules } : base.rules ? { rules: base.rules } : {}),
    ...(patch.knowledge ? { knowledge: patch.knowledge } : base.knowledge ? { knowledge: base.knowledge } : {}),
    ...(patch.skills ? { skills: patch.skills } : base.skills ? { skills: base.skills } : {}),
    ...(patch.instructions ? { instructions: patch.instructions } : base.instructions ? { instructions: base.instructions } : {}),
    ...(patch.concludeFile ? { concludeFile: patch.concludeFile } : base.concludeFile ? { concludeFile: base.concludeFile } : {}),
  };
}

function mergeContext(base: ContextSpec, patch?: Partial<ContextSpec>): ContextSpec {
  if (!patch) return base;
  const merged: ContextSpec = { graphView: patch.graphView ?? base.graphView };
  const maxFacts = patch.maxFacts ?? base.maxFacts;
  if (maxFacts !== undefined) merged.maxFacts = maxFacts;
  if (patch.includeDeadEnds !== undefined) merged.includeDeadEnds = patch.includeDeadEnds;
  else if (base.includeDeadEnds !== undefined) merged.includeDeadEnds = base.includeDeadEnds;
  if (patch.includeProgress !== undefined) merged.includeProgress = patch.includeProgress;
  else if (base.includeProgress !== undefined) merged.includeProgress = base.includeProgress;
  if (patch.relevanceScope !== undefined) merged.relevanceScope = patch.relevanceScope;
  else if (base.relevanceScope !== undefined) merged.relevanceScope = base.relevanceScope;
  return merged;
}

/**
 * Inject a list of named agents into the builtin profiles. Each agent patches
 * its declared slot. Returns the patched profiles and the union of worker
 * definitions the agents bring (caller merges these under its own workers).
 */
export function injectAgents(
  baseProfiles: BuiltinProfiles & Record<string, SubagentProfile>,
  agentNames: string[],
  opts: InjectionOptions = {},
): { profiles: BuiltinProfiles & Record<string, SubagentProfile>; workers: Record<WorkerName, WorkerConfig> } {
  const profiles: BuiltinProfiles & Record<string, SubagentProfile> = { ...baseProfiles };
  const workers: Record<WorkerName, WorkerConfig> = {};

  for (const name of agentNames) {
    const agent = loadAgent(name, opts);
    const slotProfile = profiles[agent.slot];
    if (!slotProfile) {
      throw new Error(`agent "${name}" targets slot "${agent.slot}" but no such builtin profile exists`);
    }
    profiles[agent.slot] = applyAgentPatch(slotProfile, agent.file);
    if (agent.file.workers) {
      for (const [wn, wc] of Object.entries(agent.file.workers)) {
        workers[wn] = wc;
      }
    }
  }

  return { profiles, workers };
}
