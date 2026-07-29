import {
  requireDescription, requireFactDescription, requireIntentDescription, requireShortDescription,
} from "../graph/api.js";
import type { FactRef } from "../graph/types.js";

export type PlanOutput =
  | { kind: "complete"; from: FactRef[]; description: string }
  | { kind: "intents"; intents: Array<{ from: FactRef[]; description: string }> }
  | { kind: "noop" };
export type SuperviseOutput = { kind: "hint"; content: string } | { kind: "noop" };
export type ExecuteOutput = {
  kind: "fact";
  description: string;
  artifact?: { localPath: string; mediaType: string };
};

export function parsePlan(text: string, maxIntents: number): PlanOutput {
  const value = record(text);
  if (value.kind === "noop") { exact(value, ["kind"]); return { kind: "noop" }; }
  if (value.kind === "complete") {
    exact(value, ["kind", "from", "description"]);
    return { kind: "complete", from: refs(value.from), description: intentDescription(value.description) };
  }
  if (value.kind === "intents") {
    exact(value, ["kind", "intents"]);
    if (!Array.isArray(value.intents) || value.intents.length === 0 || value.intents.length > maxIntents) {
      throw new Error(`intents must contain 1-${maxIntents} items`);
    }
    return { kind: "intents", intents: value.intents.map((item) => {
      const intent = asRecord(item, "intent");
      exact(intent, ["from", "description"]);
      return { from: refs(intent.from), description: intentDescription(intent.description) };
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
  exact(value, value.artifact === undefined ? ["kind", "description"] : ["kind", "description", "artifact"]);
  if (value.kind !== "fact") throw new Error("invalid execute kind");
  const output: ExecuteOutput = { kind: "fact", description: factDescription(value.description) };
  if (value.artifact !== undefined) {
    const artifact = asRecord(value.artifact, "artifact");
    exact(artifact, ["localPath", "mediaType"]);
    output.artifact = {
      localPath: description(artifact.localPath, "artifact.localPath"),
      mediaType: description(artifact.mediaType, "artifact.mediaType"),
    };
  }
  return output;
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
  if (first !== -1 && last !== -1 && last > first) return stripped.slice(first, last + 1);
  return stripped;
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
