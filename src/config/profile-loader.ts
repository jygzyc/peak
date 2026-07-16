/**
 * Profile loader — normalizes SubagentProfile configuration.
 *
 * Strict profiles-only normalization for the public profile schema.
 * Every profile MUST declare runtime, prompt, context, permissions, and output.
 */

import type {
  Permission,
  PromptSpec,
  RuntimeSpec,
  SubagentProfile,
  ContextSpec,
  OutputSpec,
  GraphView,
  OutputContract,
  MetacogTriggers,
  SessionRole,
  RetryPolicy,
} from "../agent/types.js";
import { BUILTIN_PERMISSIONS } from "../agent/types.js";

type Raw = Record<string, unknown>;

const VALID_PERMISSIONS = new Set<string>([
  "create_intent", "fail_intent", "handle_hint", "create_subagent_explorer",
  "stop_subagent_explorer", "create_end_fact", "handle_intent", "write_candidate_fact",
  "change_fact", "receive_fact_broadcast", "create_hint", "get_graph", "send_fact_broadcast",
]);
const VALID_ROLES = new Set<SessionRole>(["planner", "explorer", "evaluator", "metacog"]);

export function normalizeProfile(profileId: string, raw: unknown): SubagentProfile {
  if (!raw || typeof raw !== "object") {
    throw new Error(`profile "${profileId}" is undefined or not an object`);
  }
  const r = raw as Raw;
  assertKnownKeys(r, [
    "role", "runtime", "prompt", "context", "permissions", "output",
    "maxActive", "intervalSeconds", "cooldownSteps", "triggers",
    "maxOutputTokens", "retry",
  ], `profile "${profileId}"`);

  const roleValue = str(r.role) ?? (VALID_ROLES.has(profileId as SessionRole) ? profileId : undefined);
  if (!roleValue || !VALID_ROLES.has(roleValue as SessionRole)) {
    throw new Error(
      `profile "${profileId}" must bind role to planner|explorer|evaluator|metacog`,
    );
  }
  const role = roleValue as SessionRole;
  const runtime = normalizeRuntime(profileId, r);
  const prompt = normalizePrompt(profileId, r);
  const context = normalizeContext(r);
  const permissions = normalizePermissions(profileId, role, r);
  const output = normalizeOutput(profileId, role, r);
  const maxActive = num(r.maxActive);
  const intervalSeconds = num(r.intervalSeconds);

  const profile: SubagentProfile = { role, runtime, prompt, context, permissions, output };
  if (maxActive !== undefined) profile.maxActive = maxActive;
  if (intervalSeconds !== undefined) profile.intervalSeconds = intervalSeconds;
  // Per-profile tuning knobs declared on SubagentProfile. These must be read
  // here (not just in defaultConfig) so task.json/agent overrides actually take
  // effect through loadConfig → normalizeProfile (docs 09-config.md).
  const cooldownSteps = num(r.cooldownSteps);
  if (cooldownSteps !== undefined) profile.cooldownSteps = cooldownSteps;
  const triggers = normalizeTriggers(r.triggers);
  if (triggers) profile.triggers = triggers;
  const maxOutputTokens = num(r.maxOutputTokens);
  if (maxOutputTokens !== undefined) profile.maxOutputTokens = maxOutputTokens;
  const retry = normalizeRetry(r.retry);
  if (retry) profile.retry = retry;
  return profile;
}

function normalizeRetry(raw: unknown): RetryPolicy | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Raw;
  assertKnownKeys(value, ["maxAttempts", "backoffMs"], "profile retry");
  const retry: RetryPolicy = {};
  const maxAttempts = num(value.maxAttempts);
  if (maxAttempts !== undefined) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("profile retry.maxAttempts must be a positive integer");
    }
    retry.maxAttempts = maxAttempts;
  }
  const backoffMs = num(value.backoffMs);
  if (backoffMs !== undefined) {
    if (backoffMs < 0) throw new Error("profile retry.backoffMs cannot be negative");
    retry.backoffMs = backoffMs;
  }
  return Object.keys(retry).length > 0 ? retry : undefined;
}

/** Normalize metacog firing triggers (everySteps/everySeconds/stagnationLevel). */
function normalizeTriggers(raw: unknown): MetacogTriggers | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const t = raw as Raw;
  assertKnownKeys(t, ["everySteps", "everySeconds", "stagnationLevel"], "profile triggers");
  const out: MetacogTriggers = {};
  const everySteps = num(t.everySteps);
  if (everySteps !== undefined) out.everySteps = everySteps;
  const everySeconds = num(t.everySeconds);
  if (everySeconds !== undefined) out.everySeconds = everySeconds;
  const stagnationLevel = num(t.stagnationLevel);
  if (stagnationLevel !== undefined) out.stagnationLevel = stagnationLevel;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRuntime(profileId: string, r: Raw): RuntimeSpec {
  const runtimeRaw = r.runtime;
  if (!runtimeRaw || typeof runtimeRaw !== "object" || Array.isArray(runtimeRaw)) {
    throw new Error(`profile "${profileId}" must declare runtime.worker`);
  }
  const src = runtimeRaw as Raw;
  assertKnownKeys(src, ["worker", "workers", "model", "provider"], `profile "${profileId}" runtime`);
  const worker = str(src.worker);
  if (!worker) {
    throw new Error(`profile "${profileId}" must declare runtime.worker`);
  }
  const spec: RuntimeSpec = { worker };
  const workers = strArr(src.workers);
  if (workers.length > 0) spec.workers = workers;
  const model = str(src.model);
  if (model) spec.model = model;
  const provider = str(src.provider);
  if (provider) spec.provider = provider;
  return spec;
}

function normalizePrompt(profileId: string, r: Raw): PromptSpec {
  const promptRaw = r.prompt;
  if (!promptRaw || typeof promptRaw !== "object" || Array.isArray(promptRaw)) {
    throw new Error(`profile "${profileId}" must declare prompt.file`);
  }
  const p = promptRaw as Raw;
  assertKnownKeys(p, ["file", "rules", "knowledge", "skills", "instructions", "concludeFile"], `profile "${profileId}" prompt`);
  const file = str(p.file);
  if (!file) {
    throw new Error(`profile "${profileId}" must declare prompt.file`);
  }
  const spec: PromptSpec = { file };
  const rules = strArr(p.rules);
  if (rules.length > 0) spec.rules = rules;
  const knowledge = strArr(p.knowledge);
  if (knowledge.length > 0) spec.knowledge = knowledge;
  const skills = strArr(p.skills);
  if (skills.length > 0) spec.skills = skills;
  const instructions = str(p.instructions);
  if (instructions) spec.instructions = instructions;
  const concludeFile = str(p.concludeFile);
  if (concludeFile) spec.concludeFile = concludeFile;
  return spec;
}

function normalizeContext(r: Raw): ContextSpec {
  const contextRaw = r.context as Raw | undefined;
  const view = (contextRaw ? str(contextRaw.graphView) : undefined) as GraphView | undefined;
  const spec: ContextSpec = { graphView: view ?? "full" };
  if (contextRaw) {
    assertKnownKeys(contextRaw, ["graphView", "maxFacts", "includeDeadEnds", "includeProgress", "relevanceScope"], "profile context");
    const maxFacts = num(contextRaw.maxFacts);
    if (maxFacts !== undefined) spec.maxFacts = maxFacts;
    if (typeof contextRaw.includeDeadEnds === "boolean") spec.includeDeadEnds = contextRaw.includeDeadEnds;
    if (typeof contextRaw.includeProgress === "boolean") spec.includeProgress = contextRaw.includeProgress;
    if (contextRaw.relevanceScope === "linked" || contextRaw.relevanceScope === "all") spec.relevanceScope = contextRaw.relevanceScope;
  }
  return spec;
}

function normalizePermissions(profileId: string, role: SessionRole, r: Raw): Permission[] {
  // A profile may narrow its role's capabilities, but cannot expand past the
  // target.md role protocol. Domain specialization belongs in prompt/config.
  if (r.permissions !== undefined) {
    if (!Array.isArray(r.permissions)) {
      throw new Error(`profile "${profileId}" permissions must be an array`);
    }
    const invalid = r.permissions.filter(
      (permission) => typeof permission !== "string" || !VALID_PERMISSIONS.has(permission),
    );
    if (invalid.length > 0) {
      throw new Error(`profile "${profileId}" contains invalid permissions`);
    }
    const declared = r.permissions as Permission[];
    const allowed = new Set(BUILTIN_PERMISSIONS[role]);
    const forbidden = declared.filter((permission) => !allowed.has(permission));
    if (forbidden.length > 0) {
      throw new Error(
        `profile "${profileId}" role "${role}" cannot declare permissions: ${forbidden.join(", ")}`,
      );
    }
    return declared;
  }
  return [...BUILTIN_PERMISSIONS[role]];
}

function normalizeOutput(profileId: string, role: SessionRole, r: Raw): OutputSpec {
  const outputRaw = r.output as Raw | undefined;
  if (outputRaw) assertKnownKeys(outputRaw, ["contract"], `profile "${profileId}" output`);
  const contract = (outputRaw ? str(outputRaw.contract) : undefined) as OutputContract | undefined;
  const fallback: Record<SessionRole, OutputContract> = {
    planner: "main_decision",
    explorer: "candidate_fact",
    evaluator: "verdict",
    metacog: "hints",
  };
  const resolved = contract ?? fallback[role];
  const allowed: Record<SessionRole, OutputContract[]> = {
    planner: ["main_decision"],
    explorer: ["candidate_fact"],
    evaluator: ["verdict"],
    metacog: ["hints", "stop"],
  };
  if (!allowed[role].includes(resolved)) {
    throw new Error(
      `profile "${profileId}" role "${role}" cannot use output contract "${resolved}"`,
    );
  }
  return { contract: resolved };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function assertKnownKeys(value: Raw, allowed: string[], label: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) throw new Error(`${label} contains unknown field "${unknown}"`);
}
