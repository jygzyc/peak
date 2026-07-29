import type { ProjectGraph } from "./types.js";

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
