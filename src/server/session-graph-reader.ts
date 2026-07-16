/** Server-owned Graph reader that produces role-safe JSON snapshots. */

import type { ContextSpec, Fact, Hint, Intent, ProjectId, Verdict } from "../agent/types.js";
import {
  createGraphContextSnapshot,
  type GraphContextSnapshot,
  type GraphSnapshotRequest,
  type SessionGraphReader,
} from "../agent/context-builder.js";
import { renderGraphView, type GraphViewInput, type GraphViewOptions } from "../agent/graph-view.js";
import type { Graph } from "../graph/graph.js";

export interface BuildContextOptions {
  projectId: ProjectId;
  graph: Graph;
  spec?: ContextSpec;
  insights?: Fact[];
  hints?: Hint[];
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  intent?: Intent;
  candidate?: Fact;
}

export class ServerSessionGraphReader implements SessionGraphReader {
  constructor(private readonly graph: Graph) {}

  async readSnapshot(request: GraphSnapshotRequest): Promise<GraphContextSnapshot> {
    request.signal?.throwIfAborted();
    return this.graph.transaction(() => {
      const content = buildDynamicContext({ ...request, graph: this.graph });
      const graphSeq = this.graph.events(request.projectId).at(-1)?.seq ?? 0;
      if (request.throughSeq !== undefined && graphSeq > request.throughSeq) {
        throw new Error(
          `graph advanced beyond requested sequence: requested=${request.throughSeq}, actual=${graphSeq}`,
        );
      }
      return createGraphContextSnapshot({
        sessionId: request.sessionId,
        projectId: request.projectId,
        graphSeq,
        view: request.spec?.graphView ?? "full",
        content,
      });
    });
  }
}

export function buildDynamicContext(options: BuildContextOptions): string {
  const { projectId, graph, spec } = options;
  const project = graph.getProject(projectId);
  const viewOptions: GraphViewOptions = {
    view: spec?.graphView ?? "full",
    maxFacts: spec?.maxFacts,
    includeDeadEnds: spec?.includeDeadEnds ?? true,
    includeProgress: spec?.includeProgress ?? false,
  };
  let passFacts = graph.facts(projectId, "pass");
  if (spec?.relevanceScope === "linked") {
    const rootIds = collectRootFactIds(options);
    if (rootIds.length > 0) passFacts = filterRelevantFacts(graph, projectId, passFacts, rootIds, 2);
  }
  const input: GraphViewInput = {
    passFacts,
    denyFacts: graph.facts(projectId, "deny"),
    candidateFacts: graph.facts(projectId, "candidate"),
    pendingFacts: graph.facts(projectId, "pending"),
    openIntents: graph.intents(projectId, "open"),
    claimedIntents: graph.intents(projectId, "claimed"),
    target: project?.target,
    goal: project?.goal,
    progress: viewOptions.includeProgress ? graph.progress(projectId) : undefined,
    recentVerdicts: options.recentVerdicts,
    broadcastAssessments: graph.events(projectId)
      .filter((event) => event.type === "federation.broadcast_assessed")
      .slice(-20)
      .map((event) => ({
        broadcastId: String(event.payload.broadcastId ?? "unknown"),
        decision: String(event.payload.decision ?? "unknown"),
        reason: String(event.payload.reason ?? ""),
        targetFactId: typeof event.payload.targetFactId === "string"
          ? event.payload.targetFactId
          : undefined,
      })),
    hints: options.hints?.map((hint) => ({
      id: hint.id,
      content: hint.content,
      creator: hint.creator,
      kind: hint.kind,
      targetIntentId: hint.targetIntentId,
    })),
  };
  return renderGraphView(input, viewOptions);
}

function collectRootFactIds(options: BuildContextOptions): string[] {
  const ids = new Set(options.intent?.parentFactIds ?? []);
  if (options.candidate?.parentIntentId) {
    const intent = options.graph.getIntent(options.projectId, options.candidate.parentIntentId);
    for (const id of intent?.parentFactIds ?? []) ids.add(id);
  }
  return [...ids];
}

function filterRelevantFacts(
  graph: Graph,
  projectId: ProjectId,
  facts: Fact[],
  rootFactIds: string[],
  maxHops: number,
): Fact[] {
  const relevant = new Set(rootFactIds);
  const edges = graph.intents(projectId).filter((intent) => intent.concludedFactId);
  for (let hop = 0; hop < maxHops; hop++) {
    const frontier = [...relevant];
    for (const intent of edges) {
      const target = intent.concludedFactId!;
      if (intent.parentFactIds.some((id) => frontier.includes(id))) relevant.add(target);
      if (frontier.includes(target)) {
        for (const id of intent.parentFactIds) relevant.add(id);
      }
    }
  }
  const filtered = facts.filter((fact) => relevant.has(fact.id));
  if (filtered.length < facts.length) return filtered;
  const seen = new Set(filtered.map((fact) => fact.id));
  for (const fact of facts.slice(-5)) {
    if (!seen.has(fact.id)) filtered.push(fact);
  }
  return filtered;
}
