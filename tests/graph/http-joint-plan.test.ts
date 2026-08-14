import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpJointPlan } from "../../dist/graph/http-joint-plan.js";
import type { JointPlanPath } from "../../dist/graph/joint-plan.js";
import { stubGraphClient } from "../helpers/fakes.ts";

test("a single-member task short-circuits without calling the graph", async () => {
  const { client, calls } = stubGraphClient();
  const plan = new HttpJointPlan(client, "task", 1);
  assert.deepEqual(await plan.paths("p1"), []);
  assert.equal(calls.length, 0, "no graph request is made for a one-project task");
});

test("multi-member tasks delegate discovery to the graph client", async () => {
  const paths: JointPlanPath[] = [{
    projectId: "p2",
    leaf: { projectId: "p2", id: "f1" },
    segments: [[{ projectId: "p2", id: "f1" }]],
  }];
  const seen: Array<{ context: unknown; target: string }> = [];
  const { client } = stubGraphClient({
    jointPlanPaths: (context: unknown, targetProjectId: string) => {
      seen.push({ context, target: targetProjectId });
      return Promise.resolve(paths);
    },
  });
  const plan = new HttpJointPlan(client, "task-x", 3);
  assert.equal(await plan.paths("p1"), paths);
  assert.deepEqual(seen, [{ context: { taskName: "task-x" }, target: "p1" }]);
});
