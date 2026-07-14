/**
 * Profile loader — normalizes SubagentProfile configuration.
 *
 * Strict profiles-only normalization. No legacy field mapping.
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
} from "../agent/types.js";
import { BUILTIN_PERMISSIONS } from "../agent/types.js";

type Raw = Record<string, unknown>;

const VALID_PERMISSIONS = new Set<string>([
  "create_intent", "fail_intent", "spawn_subagent", "cancel_subagent",
  "resolve_fact", "write_candidate_fact", "write_hint", "conclude_run",
]);

export function normalizeProfile(profileId: string, raw: unknown): SubagentProfile {
  if (!raw || typeof raw !== "object") {
    throw new Error(`profile "${profileId}" is undefined or not an object`);
  }
  const r = raw as Raw;

  const role = str(r.role) ?? profileId;
  const runtime = normalizeRuntime(profileId, r);
  const prompt = normalizePrompt(profileId, r);
  const context = normalizeContext(r);
  const permissions = normalizePermissions(profileId, role, r);
  const output = normalizeOutput(r);
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
  const sessionReuse = r.sessionReuse;
  if (typeof sessionReuse === "boolean") profile.sessionReuse = sessionReuse;
  const maxOutputTokens = num(r.maxOutputTokens);
  if (maxOutputTokens !== undefined) profile.maxOutputTokens = maxOutputTokens;
  const promptCache = r.promptCache;
  if (typeof promptCache === "boolean") profile.promptCache = promptCache;
  return profile;
}

/** Normalize metacog firing triggers (everySteps/everySeconds/stagnationLevel). */
function normalizeTriggers(raw: unknown): MetacogTriggers | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const t = raw as Raw;
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
  const runtimeRaw = r.runtime as Raw | undefined;
  const src = runtimeRaw ?? r;
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
  const file = str(p.file);
  if (!file) {
    throw new Error(`profile "${profileId}" must declare prompt.file`);
  }
  const spec: PromptSpec = { file };
  const rules = strArr(p.rules);
  if (rules.length > 0) spec.rules = rules;
  const knowledge = strArr(p.knowledge);
  if (knowledge.length > 0) spec.knowledge = knowledge;
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
    const maxFacts = num(contextRaw.maxFacts);
    if (maxFacts !== undefined) spec.maxFacts = maxFacts;
    if (typeof contextRaw.includeDeadEnds === "boolean") spec.includeDeadEnds = contextRaw.includeDeadEnds;
    if (typeof contextRaw.includeProgress === "boolean") spec.includeProgress = contextRaw.includeProgress;
    if (typeof contextRaw.rotateOnContextFull === "boolean") spec.rotateOnContextFull = contextRaw.rotateOnContextFull;
    if (contextRaw.relevanceScope === "linked" || contextRaw.relevanceScope === "all") spec.relevanceScope = contextRaw.relevanceScope;
  }
  return spec;
}

function normalizePermissions(profileId: string, role: string, r: Raw): Permission[] {
  // Honor an explicit `permissions` array declared on the profile. Custom roles
  // (e.g. android-source-finder) previously got [] here because only the
  // builtin role lookup was consulted — raw.permissions was discarded entirely
  // (docs 09-config.md §9.3). When the profile does NOT declare permissions we
  // keep the builtin default so existing builtin-role configs are unchanged.
  if (Array.isArray(r.permissions)) {
    const declared = r.permissions
      .filter((p): p is string => typeof p === "string" && VALID_PERMISSIONS.has(p))
      .map((p) => p as Permission);
    return declared;
  }
  return BUILTIN_PERMISSIONS[role] ?? BUILTIN_PERMISSIONS[profileId] ?? [];
}

function normalizeOutput(r: Raw): OutputSpec {
  const outputRaw = r.output as Raw | undefined;
  const contract = (outputRaw ? str(outputRaw.contract) : undefined) as OutputContract | undefined;
  return { contract: contract ?? "candidate_fact" };
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
