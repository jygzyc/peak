import assert from "node:assert/strict";
import { test } from "node:test";
import { computePaths, leafFacts, type ProjectGraph } from "../dist/graph/types.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const at = "2026-01-01T00:00:00.000Z";

test("leafFacts keeps only the current ordinary proof frontier", () => {
  const graph: ProjectGraph = {
    project: { id: projectId, title: "P", status: "active", createdAt: at },
    facts: ["origin", "goal", "1", "2", "3"].map((id) => ({ id, description: id, artifact: null, createdAt: at })),
    intents: [
      intent("1", "origin", "1"),
      intent("2", "1", "2"),
      intent("3", "1", "3"),
      intent("4", "2", null),
    ],
    hints: [],
  };

  assert.deepEqual(leafFacts(graph).map((fact) => fact.id), ["2", "3"]);

  graph.intents.push(intent("5", "2", "goal"));
  assert.deepEqual(leafFacts(graph).map((fact) => fact.id), ["2", "3"]);

  graph.facts.push({ id: "4", description: "4", artifact: null, createdAt: at });
  graph.intents.push(intent("6", ["2", "3"], "4"));
  assert.deepEqual(leafFacts(graph).map((fact) => fact.id), ["4"]);
});

test("computePaths collects each leaf's full concluded ancestry, merges included, as one Path", () => {
  const graph: ProjectGraph = {
    project: { id: projectId, title: "P", status: "active", createdAt: at },
    facts: ["origin", "goal", "1", "2", "3", "4", "5", "6"].map((id) => ({ id, description: id, artifact: null, createdAt: at })),
    intents: [
      intent("1", "origin", "1"),
      intent("2", "origin", "2"),
      intent("3", ["1", "2"], "3"),
      intent("4", "3", "4"),
      intent("5", "4", "5"),
      intent("6", "5", "6"),
      intent("7", "6", null), // open: no edge, 6 stays the leaf
    ],
    hints: [],
  };

  const paths = computePaths(graph);
  assert.equal(paths.length, 1, "one leaf, one Path — merged branches are not split into maximal chains");
  const path = paths[0]!;
  assert.deepEqual(path.leaf, { projectId, id: "6", description: "6" });
  assert.equal(path.truncated, false);
  assert.deepEqual(path.segments.map((segment) => segment.map((step) => step.fact.id)), [
    ["3", "4", "5", "6"],
    ["origin", "1"],
    ["origin", "2"],
  ]);
  assert.equal(path.segments[1]![0]!.viaIntent, null, "root step has no producing Intent");
  assert.deepEqual(path.segments[0]![0]!.viaIntent, { id: "3", description: "3" }, "merge step carries its producing Intent");

  // A concluded Intent targeting the goal appends the completion hop.
  graph.intents[6] = intent("7", "6", "goal");
  const completed = computePaths(graph)[0]!;
  assert.deepEqual(completed.segments[0]!.map((step) => step.fact.id), ["3", "4", "5", "6", "goal"]);

  // leafFactId restricts computation to that Fact's ancestry.
  const single = computePaths(graph, "4");
  assert.equal(single.length, 1);
  assert.deepEqual(single[0]!.segments.map((segment) => segment.map((step) => step.fact.id)), [
    ["3", "4"],
    ["origin", "1"],
    ["origin", "2"],
  ]);
});

test("computePaths gives each forked leaf its own Path and skips fresh Projects", () => {
  const graph: ProjectGraph = {
    project: { id: projectId, title: "P", status: "active", createdAt: at },
    facts: ["origin", "goal", "1", "2", "3"].map((id) => ({ id, description: id, artifact: null, createdAt: at })),
    intents: [
      intent("1", "origin", "1"),
      intent("2", "1", "2"),
      intent("3", "1", "3"),
    ],
    hints: [],
  };

  const byLeaf = new Map(computePaths(graph).map((path) => [path.leaf.id, path]));
  assert.deepEqual([...byLeaf.keys()].sort(), ["2", "3"]);
  assert.deepEqual(byLeaf.get("2")!.segments.map((segment) => segment.map((step) => step.fact.id)), [["origin", "1", "2"]]);
  assert.deepEqual(byLeaf.get("3")!.segments.map((segment) => segment.map((step) => step.fact.id)), [["origin", "1", "3"]]);

  graph.intents.length = 0;
  assert.deepEqual(computePaths(graph), [], "no concluded Intent, no Paths");
});

function intent(id: string, from: string | string[], to: string | null) {
  const sources = Array.isArray(from) ? from : [from];
  return {
    id,
    from: sources.map((id) => ({ projectId, id, description: id })),
    to: to === null ? null : { projectId, id: to, description: to },
    description: id,
    createdBy: "test",
    createdAt: at,
    concludedBy: to === null ? null : "test",
    concludedAt: to === null ? null : at,
  };
}
