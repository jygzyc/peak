import {
  requireDescription, requireFactDescription, requireIntentDescription, requireShortDescription,
} from "../graph/api.js";
import type { FactRef } from "../graph/types.js";

type PlanOutput =
  | { kind: "complete"; from: FactRef[]; hintIds: string[]; description: string }
  | { kind: "intents"; intents: Array<{ from: FactRef[]; customProfile: string | null; customProfileDigest: string | null; hintIds: string[]; description: string }> }
  | { kind: "noop" };
type SuperviseOutput = { kind: "hint"; content: string } | { kind: "noop" };
type AnalyzeOutput = { pathOverview: string; verifiedCore: string[] };
type ExecuteOutput = {
  kind: "fact";
  description: string;
  artifact: { filename: string | null; mediaType: string; content: string } | null;
};

export function parsePlan(text: string, maxIntents: number, availableCustomProfiles: Array<{ description: string; digest: string }> = []): PlanOutput {
  const value = record(text);
  if (value.kind === "noop") { exact(value, ["kind"]); return { kind: "noop" }; }
  if (value.kind === "complete") {
    exact(value, ["kind", "from", "hintIds", "description"], ["hintIds"]);
    return { kind: "complete", from: refs(value.from), hintIds: ids(value.hintIds), description: requireIntentDescription(value.description) };
  }
  if (value.kind === "intents") {
    exact(value, ["kind", "intents"]);
    if (!Array.isArray(value.intents) || value.intents.length === 0 || value.intents.length > maxIntents) {
      throw new Error(`intents must contain 1-${maxIntents} items`);
    }
    return { kind: "intents", intents: value.intents.map((item) => {
      const intent = asRecord(item, "intent");
      exact(intent, ["from", "customProfile", "customProfileDigest", "hintIds", "description"], ["customProfile", "customProfileDigest", "hintIds"]);
      // Profiles are selected by their short digest token (a 16-hex-char string
      // the Plan AI can copy reliably); the full description is also accepted
      // for compatibility with older Plan workers. When both are present the
      // digest wins.
      const digest = nullableDescription(intent.customProfileDigest, "customProfileDigest");
      const legacy = nullableDescription(intent.customProfile, "customProfile");
      const resolved = digest !== null
        ? availableCustomProfiles.find((profile) => profile.digest === digest)
        : legacy !== null
          ? availableCustomProfiles.find((profile) => profile.description === legacy)
          : null;
      if (digest !== null && !resolved) throw new Error(`unknown customProfileDigest: ${digest}`);
      if (digest === null && legacy !== null && !resolved) throw new Error(`unknown customProfile: ${legacy}`);
      return {
        from: refs(intent.from),
        customProfile: resolved?.description ?? null,
        customProfileDigest: resolved?.digest ?? null,
        hintIds: ids(intent.hintIds),
        description: requireIntentDescription(intent.description),
      };
    }) };
  }
  throw new Error("invalid plan kind");
}

export function parseAnalyze(text: string): AnalyzeOutput {
  const value = record(text);
  exact(value, ["pathOverview", "verifiedCore"]);
  if (!Array.isArray(value.verifiedCore) || value.verifiedCore.length === 0 || value.verifiedCore.length > 16) {
    throw new Error("verifiedCore must contain 1-16 items");
  }
  return {
    pathOverview: requireDescription(value.pathOverview, "pathOverview"),
    verifiedCore: value.verifiedCore.map((item) => requireShortDescription(item, "verifiedCore")),
  };
}

export function parseSupervise(text: string): SuperviseOutput {
  const value = record(text);
  if (value.kind === "noop") { exact(value, ["kind"]); return { kind: "noop" }; }
  if (value.kind === "hint") {
    exact(value, ["kind", "content"]);
    return { kind: "hint", content: requireShortDescription(value.content, "content") };
  }
  throw new Error("invalid supervise kind");
}

export function parseExecute(text: string): ExecuteOutput {
  const value = record(text);
  // `artifact` defaults to null when the model omits it: weaker models
  // routinely drop optional-looking fields, and a Fact without an Artifact
  // is always valid — nothing else in the contract is relaxed.
  exact(value, ["kind", "description", "artifact"], ["artifact"]);
  if (value.kind !== "fact") throw new Error("invalid execute kind");
  const artifact = (value.artifact === undefined || value.artifact === null) ? null : asRecord(value.artifact, "artifact");
  if (artifact) exact(artifact, ["filename", "mediaType", "content"], ["filename"]);
  return {
    kind: "fact",
    description: requireFactDescription(value.description),
    artifact: artifact && {
      filename: artifact.filename === undefined || artifact.filename === null
        ? null : requireShortDescription(artifact.filename, "artifact.filename"),
      mediaType: requireDescription(artifact.mediaType, "artifact.mediaType"),
      content: content(artifact.content),
    },
  };
}

function content(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("artifact.content is required");
  return value;
}

function record(text: string): Record<string, unknown> {
  const candidate = extractJson(text);
  try { return asRecord(JSON.parse(candidate) as unknown, "output"); }
  catch (error) { throw new Error(`worker output must be one JSON object: ${(error as Error).message}`); }
}
function extractJson(text: string): string {
  // Reasoning models (MiniMax-M3, GLM, DeepSeek-R1, QwQ, ...) often wrap
  // their answer in <think>...</think> blocks whose prose frequently contains
  // unbalanced `{`/`}` while the model reasons about the JSON shape. Strip
  // those blocks first so the brace/fence heuristics below see only the answer.
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fences = [...stripped.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  if (fences.length) return fences[fences.length - 1]![1]!.trim();
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    // Prefer the first brace-balanced JSON object so trailing prose is ignored
    // even when that prose itself contains `{`/`}` (e.g. markdown tables or
    // explanations following the JSON object).
    const balanced = balancedObject(stripped, first);
    return balanced ?? stripped.slice(first, last + 1);
  }
  return stripped;
}

/**
 * Returns the first brace-balanced top-level JSON object at or after `start`
 * that parses, or undefined. String literals and escapes are respected so
 * braces inside strings do not unbalance the scan.
 */
function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { depth += 1; continue; }
    if (ch !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    const candidate = text.slice(start, i + 1);
    try { JSON.parse(candidate); return candidate; } catch { return undefined; }
  }
  return undefined;
}
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: string[], optional: string[] = []): void {
  const keys = Object.keys(value);
  const invalid = keys.find((key) => !allowed.includes(key));
  const missing = allowed.find((key) => !optional.includes(key) && !(key in value));
  if (invalid || missing) throw new Error(invalid ? `unknown field: ${invalid}` : `missing field: ${missing}`);
}
function ids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("hintIds must be an array");
  const result = value.map((item) => requireDescription(item, "hintId"));
  if (new Set(result).size !== result.length) throw new Error("hintIds contains duplicates");
  return result;
}
function refs(value: unknown): FactRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("FactRef array must not be empty");
  return value.map((item) => {
    const ref = asRecord(item, "FactRef");
    exact(ref, ["projectId", "id", "description"]);
    return {
      projectId: requireDescription(ref.projectId, "projectId"),
      id: requireDescription(ref.id, "id"),
      description: requireDescription(ref.description),
    };
  });
}
function nullableDescription(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : requireDescription(value, label);
}
