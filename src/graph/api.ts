import type { ProjectGraph } from "./types.js";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const MAX_DESCRIPTION_BYTES = 4 * 1024;
const MAX_SHORT_DESCRIPTION_BYTES = 1024;
const MAX_INTENT_DESCRIPTION_BYTES = 2 * 1024;

export function requireDescription(value: unknown, label = "description"): string {
  return requireText(value, label, MAX_DESCRIPTION_BYTES, "4 KiB");
}

export function requireShortDescription(value: unknown, label = "description"): string {
  return requireText(value, label, MAX_SHORT_DESCRIPTION_BYTES, "1 KiB");
}

export function requireFactDescription(value: unknown, label = "description"): string {
  return requireShortDescription(value, label);
}

export function requireIntentDescription(value: unknown, label = "description"): string {
  return requireText(value, label, MAX_INTENT_DESCRIPTION_BYTES, "2 KiB");
}

function requireText(value: unknown, label: string, maxBytes: number, displayLimit: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ApiError(400, `${label} is required`);
  const result = value.trim();
  if (Buffer.byteLength(result, "utf8") > maxBytes) throw new ApiError(400, `${label} exceeds ${displayLimit}`);
  return result;
}

export function requireCustomProfileDigest(value: unknown, label = "customProfileDigest"): string {
  const result = requireShortDescription(value, label);
  if (!/^[0-9a-f]{16}$/.test(result)) throw new ApiError(400, `${label} is invalid`);
  return result;
}

export function localTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new ApiError(400, "invalid project id");
  return value;
}

/**
 * True when a content-based Artifact filename would escape its directory:
 * backslash, absolute path, or any traversal segment (empty, `.`, `..`,
 * dot-prefixed). Shared by the HTTP upload path and the archive importer so
 * both enforce identical validation. Callers throw their own error type.
 */
export function hasUnsafeFilenameSegments(name: string): boolean {
  return name.includes("\\") || name.startsWith("/")
    || name.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."));
}

export function toTimeline(graphs: ProjectGraph | ProjectGraph[]): unknown[] {
  const values = Array.isArray(graphs) ? graphs : [graphs];
  return values.flatMap((graph) => [
    ...graph.facts.map((fact) => ({ at: fact.createdAt, projectId: graph.project.id, type: "fact", value: fact })),
    ...graph.intents.map((intent) => ({ at: intent.createdAt, projectId: graph.project.id, type: "intent", value: intent })),
    ...graph.hints.map((hint) => ({ at: hint.createdAt, projectId: graph.project.id, type: "hint", value: hint })),
  ]).sort((left, right) => left.at.localeCompare(right.at));
}

export function toJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
