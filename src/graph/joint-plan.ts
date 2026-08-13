import type { FactRef } from "./types.js";

/** One current leaf Path discovered from a Project mounted by the same Task. */
export interface JointPlanPath {
  projectId: string;
  leaf: FactRef;
  segments: FactRef[][];
}

export interface TaskFederationContext { taskName: string }

/** Runtime boundary for discovering the peer Paths used by a Joint Plan. */
export interface JointPlan {
  paths(targetProjectId: string): JointPlanPath[] | Promise<JointPlanPath[]>;
}
