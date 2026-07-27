import type { ProjectGraph } from "./types.js";

export function toTimeline(graphs: ProjectGraph | ProjectGraph[]): unknown[] {
  const values = Array.isArray(graphs) ? graphs : [graphs];
  return values.flatMap((graph) => [
    ...graph.facts.map((fact) => ({ at: fact.createdAt, projectId: graph.project.id, type: "fact", value: fact })),
    ...graph.intents.map((intent) => ({ at: intent.createdAt, projectId: graph.project.id, type: "intent", value: intent })),
    ...graph.hints.map((hint) => ({ at: hint.createdAt, projectId: graph.project.id, type: "hint", value: hint })),
  ]).sort((left, right) => left.at.localeCompare(right.at));
}

export function toYaml(value: unknown): string {
  return `${render(value, 0)}\n`;
}

function render(value: unknown, depth: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((item) => `${indent(depth)}- ${renderNested(item, depth)}`).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return "{}";
    return entries.map(([key, item]) => `${indent(depth)}${key}: ${renderNested(item, depth)}`).join("\n");
  }
  return scalar(value);
}

function renderNested(value: unknown, depth: number): string {
  if ((Array.isArray(value) && value.length > 0) || (isRecord(value) && Object.keys(value).length > 0)) {
    return `\n${render(value, depth + 1)}`;
  }
  return render(value, depth + 1);
}

function scalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function indent(depth: number): string { return "  ".repeat(depth); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
