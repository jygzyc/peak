/** Process-local coordination state for one SessionLoop.
 *
 * Retry counters, planner cooldowns and broadcast notifications control live
 * execution. They are deliberately not part of the persistent task Graph.
 */
import type { ProjectId, Verdict } from "../agent/types.js";

export interface RecentVerdict {
  factId: string;
  verdict: Verdict;
  intentId?: string;
}

interface FailureState {
  count: number;
  lastAt: number;
}

interface ProjectRuntimeState {
  lastPlannerStep: number;
  recentVerdicts: RecentVerdict[];
  relevantBroadcast: boolean;
  failures: Map<string, FailureState>;
}

export class SessionCoordinator {
  private readonly projects = new Map<ProjectId, ProjectRuntimeState>();

  lastPlannerStep(projectId: ProjectId): number {
    return this.state(projectId).lastPlannerStep;
  }

  recordPlannerDecision(projectId: ProjectId, step: number): void {
    const state = this.state(projectId);
    state.lastPlannerStep = step;
    state.recentVerdicts = [];
    state.relevantBroadcast = false;
    state.failures.delete("planner");
  }

  recentVerdicts(projectId: ProjectId): RecentVerdict[] {
    return [...this.state(projectId).recentVerdicts];
  }

  recordVerdict(projectId: ProjectId, verdict: RecentVerdict): void {
    this.state(projectId).recentVerdicts.push(verdict);
  }

  hasRelevantBroadcastSincePlanner(projectId: ProjectId): boolean {
    return this.state(projectId).relevantBroadcast;
  }

  recordRelevantBroadcast(projectId: ProjectId): void {
    this.state(projectId).relevantBroadcast = true;
  }

  recordFailure(projectId: ProjectId, key: string): number {
    const failures = this.state(projectId).failures;
    const current = failures.get(key);
    const next = { count: (current?.count ?? 0) + 1, lastAt: Date.now() };
    failures.set(key, next);
    return next.count;
  }

  failureCount(projectId: ProjectId, key: string): number {
    return this.state(projectId).failures.get(key)?.count ?? 0;
  }

  retryDelayRemaining(projectId: ProjectId, key: string, backoffMs: number): number {
    if (backoffMs <= 0) return 0;
    const failure = this.state(projectId).failures.get(key);
    return failure ? Math.max(0, failure.lastAt + backoffMs - Date.now()) : 0;
  }

  private state(projectId: ProjectId): ProjectRuntimeState {
    let state = this.projects.get(projectId);
    if (!state) {
      state = {
        lastPlannerStep: -99,
        recentVerdicts: [],
        relevantBroadcast: false,
        failures: new Map(),
      };
      this.projects.set(projectId, state);
    }
    return state;
  }
}
