import type { GraphClient } from "./graph-client.js";
import type { JointPlan, JointPlanPath, TaskFederationContext } from "./joint-plan.js";

/** HTTP-backed Joint Plan discovery for one Task-mounted Project. */
export class HttpJointPlan implements JointPlan {
  constructor(
    private readonly graph: GraphClient,
    private readonly taskName: string,
    private readonly memberCount: number,
  ) {}

  /** Returns every current leaf Path owned by another Project in this Task. */
  paths(targetProjectId: string): Promise<JointPlanPath[]> {
    if (this.memberCount < 2) return Promise.resolve([]);
    const context: TaskFederationContext = { taskName: this.taskName };
    return this.graph.jointPlanPaths(context, targetProjectId);
  }
}
