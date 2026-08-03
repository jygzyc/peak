import assert from "node:assert/strict";
import { test } from "node:test";
import { leafFacts, type ProjectGraph } from "../dist/graph/types.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const at = "2026-01-01T00:00:00.000Z";

test("leafFacts keeps only the current ordinary proof frontier", () => {
  const graph: ProjectGraph = {
    project: { id: projectId, title: "P", status: "active", createdAt: at },
    facts: ["origin", "goal", "f001", "f002", "f003"].map((id) => ({ id, description: id, artifact: null, createdAt: at })),
    intents: [
      intent("i001", "origin", "f001"),
      intent("i002", "f001", "f002"),
      intent("i003", "f001", "f003"),
      intent("i004", "f002", null),
    ],
    hints: [],
  };

  assert.deepEqual(leafFacts(graph).map((fact) => fact.id), ["f002", "f003"]);

  graph.intents.push(intent("i005", "f002", "goal"));
  assert.deepEqual(leafFacts(graph).map((fact) => fact.id), ["f002", "f003"]);

  graph.facts.push({ id: "f004", description: "f004", artifact: null, createdAt: at });
  graph.intents.push(intent("i006", ["f002", "f003"], "f004"));
  assert.deepEqual(leafFacts(graph).map((fact) => fact.id), ["f004"]);
});

function intent(id: string, from: string | string[], to: string | null) {
  const sources = Array.isArray(from) ? from : [from];
  return {
    id,
    from: sources.map((factId) => ({ projectId, factId, description: factId })),
    to: to === null ? null : { projectId, factId: to, description: to },
    description: id,
    createdBy: "test",
    createdAt: at,
    concludedBy: to === null ? null : "test",
    concludedAt: to === null ? null : at,
  };
}
