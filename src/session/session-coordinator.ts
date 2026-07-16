/** Durable coordinator queries derived exclusively from Graph events.
 *
 * This class intentionally owns no mutable cursor Map. Reconstructing it after
 * a process restart produces the same verdict inbox, retry counters, and
 * planner cooldown position as the previous coordinator observed.
 */
import type { ProjectId, Verdict } from "../agent/types.js";
import type { Graph } from "../graph/graph.js";

export interface RecentVerdict {
  factId: string;
  verdict: Verdict;
  intentId?: string;
}

export class SessionCoordinator {
  constructor(private readonly graph: Graph) {}

  lastPlannerDecisionSeq(projectId: ProjectId): number {
    return this.lastEvent(projectId, "planner.decision_applied")?.seq ?? 0;
  }

  lastPlannerStep(projectId: ProjectId): number {
    return Number(this.lastEvent(projectId, "planner.decision_applied")?.payload.stepsExecuted ?? -99);
  }

  recentVerdicts(projectId: ProjectId): RecentVerdict[] {
    const cursor = this.lastPlannerDecisionSeq(projectId);
    return this.graph.events(projectId).flatMap((event) => {
      if (event.seq <= cursor || event.type !== "fact.resolved") return [];
      const factId = typeof event.payload.factId === "string" ? event.payload.factId : undefined;
      const verdict = event.payload.verdict;
      if (!factId || !verdict || typeof verdict !== "object" || Array.isArray(verdict)) return [];
      const decision = (verdict as Record<string, unknown>).decision;
      const reason = (verdict as Record<string, unknown>).reason;
      if ((decision !== "pass" && decision !== "deny" && decision !== "pending")
        || typeof reason !== "string") return [];
      return [{
        factId,
        verdict: verdict as Verdict,
        intentId: this.graph.getFact(projectId, factId)?.parentIntentId,
      }];
    });
  }

  hasRelevantBroadcastSincePlanner(projectId: ProjectId): boolean {
    const cursor = this.lastPlannerDecisionSeq(projectId);
    return this.graph.events(projectId).some((event) =>
      event.seq > cursor
      && event.type === "federation.broadcast_assessed"
      && event.payload.decision !== "irrelevant");
  }

  plannerFailureCount(projectId: ProjectId): number {
    const cursor = this.lastPlannerDecisionSeq(projectId);
    return this.graph.events(projectId).filter((event) =>
      event.seq > cursor && event.type === "planner.error").length;
  }

  explorerFailureCount(projectId: ProjectId, intentId: string): number {
    return this.graph.events(projectId).filter((event) =>
      event.type === "explorer.error" && event.payload.intentId === intentId).length;
  }

  evaluatorFailureCount(projectId: ProjectId, factId: string): number {
    return this.graph.events(projectId).filter((event) =>
      event.type === "evaluator.error" && event.payload.factId === factId).length;
  }

  broadcastFailureCount(projectId: ProjectId, broadcastId: string): number {
    return this.graph.events(projectId).filter((event) =>
      event.type === "federation.broadcast_error" && event.payload.broadcastId === broadcastId).length;
  }

  retryDelayRemaining(
    projectId: ProjectId,
    eventType: string,
    backoffMs: number,
    afterSeq = 0,
  ): number {
    if (backoffMs <= 0) return 0;
    const event = [...this.graph.events(projectId)].reverse().find((candidate) =>
      candidate.seq > afterSeq && candidate.type === eventType);
    if (!event) return 0;
    return Math.max(0, Date.parse(event.timestamp) + backoffMs - Date.now());
  }

  private lastEvent(projectId: ProjectId, type: string) {
    return [...this.graph.events(projectId)].reverse().find((event) => event.type === type);
  }
}
