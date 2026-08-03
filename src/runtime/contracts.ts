import {
  requireDescription, requireFactDescription, requireIntentDescription, requireShortDescription,
} from "../graph/api.js";
import type { FactRef } from "../graph/types.js";

export type PlanOutput =
  | { kind: "complete"; from: FactRef[]; hintIds: string[]; description: string }
  | { kind: "intents"; intents: Array<{ from: FactRef[]; customProfile: string | null; hintIds: string[]; description: string }> }
  | { kind: "noop" };
export type SuperviseOutput = { kind: "hint"; content: string } | { kind: "noop" };
export type ExecuteOutput = {
  kind: "fact";
  description: string;
  artifact: { filename: string | null; mediaType: string; content: string } | null;
};

export function parsePlan(text: string, maxIntents: number, availableCustomProfiles: string[] = []): PlanOutput {
  const value = record(text);
  if (value.kind === "noop") { exact(value, ["kind"]); return { kind: "noop" }; }
  if (value.kind === "complete") {
    exactOptional(value, ["kind", "from", "hintIds", "description"], ["hintIds"]);
    return { kind: "complete", from: refs(value.from), hintIds: ids(value.hintIds), description: intentDescription(value.description) };
  }
  if (value.kind === "intents") {
    exact(value, ["kind", "intents"]);
    if (!Array.isArray(value.intents) || value.intents.length === 0 || value.intents.length > maxIntents) {
      throw new Error(`intents must contain 1-${maxIntents} items`);
    }
    return { kind: "intents", intents: value.intents.map((item) => {
      const intent = asRecord(item, "intent");
      exactOptional(intent, ["from", "customProfile", "hintIds", "description"], ["customProfile", "hintIds"]);
      const customProfile = intent.customProfile === undefined || intent.customProfile === null
        ? null : description(intent.customProfile, "customProfile");
      if (customProfile && !availableCustomProfiles.includes(customProfile)) throw new Error(`unknown customProfile: ${customProfile}`);
      return { from: refs(intent.from), customProfile, hintIds: ids(intent.hintIds), description: intentDescription(intent.description) };
    }) };
  }
  throw new Error("invalid plan kind");
}

export function parseSupervise(text: string): SuperviseOutput {
  const value = record(text);
  if (value.kind === "noop") { exact(value, ["kind"]); return { kind: "noop" }; }
  if (value.kind === "hint") {
    exact(value, ["kind", "content"]);
    return { kind: "hint", content: shortDescription(value.content, "content") };
  }
  throw new Error("invalid supervise kind");
}

export function parseExecute(text: string): ExecuteOutput {
  const value = record(text);
  exact(value, ["kind", "description", "artifact"]);
  if (value.kind !== "fact") throw new Error("invalid execute kind");
  const artifact = value.artifact === null ? null : asRecord(value.artifact, "artifact");
  if (artifact) exactOptional(artifact, ["filename", "mediaType", "content"], ["filename"]);
  return {
    kind: "fact",
    description: factDescription(value.description),
    artifact: artifact && {
      filename: artifact.filename === undefined || artifact.filename === null ? null : shortDescription(artifact.filename, "artifact.filename"),
      mediaType: description(artifact.mediaType, "artifact.mediaType"),
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
function exact(value: Record<string, unknown>, allowed: string[]): void {
  const keys = Object.keys(value);
  const invalid = keys.find((key) => !allowed.includes(key));
  const missing = allowed.find((key) => !(key in value));
  if (invalid || missing) throw new Error(invalid ? `unknown field: ${invalid}` : `missing field: ${missing}`);
}
function exactOptional(value: Record<string, unknown>, allowed: string[], optional: string[]): void {
  const keys = Object.keys(value);
  const invalid = keys.find((key) => !allowed.includes(key));
  const missing = allowed.find((key) => !optional.includes(key) && !(key in value));
  if (invalid || missing) throw new Error(invalid ? `unknown field: ${invalid}` : `missing field: ${missing}`);
}
function ids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("hintIds must be an array");
  const result = value.map((item) => description(item, "hintId"));
  if (new Set(result).size !== result.length) throw new Error("hintIds contains duplicates");
  return result;
}
function refs(value: unknown): FactRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("FactRef array must not be empty");
  return value.map((item) => {
    const ref = asRecord(item, "FactRef");
    exact(ref, ["projectId", "factId", "description"]);
    return {
      projectId: description(ref.projectId, "projectId"),
      factId: description(ref.factId, "factId"),
      description: description(ref.description),
    };
  });
}
function description(value: unknown, label = "description"): string {
  try { return requireDescription(value, label); }
  catch (error) { throw new Error((error as Error).message); }
}
function shortDescription(value: unknown, label = "description"): string {
  try { return requireShortDescription(value, label); }
  catch (error) { throw new Error((error as Error).message); }
}
function factDescription(value: unknown): string {
  try { return requireFactDescription(value); }
  catch (error) { throw new Error((error as Error).message); }
}
function intentDescription(value: unknown): string {
  try { return requireIntentDescription(value); }
  catch (error) { throw new Error((error as Error).message); }
}
