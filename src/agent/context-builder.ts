/**
 * Context builder — assembles the dynamic prompt context for a subagent.
 *
 * Given a SubagentProfile's ContextSpec and the current graph state, produces
 * a rendered graph-view section. The caller (SubagentRunner / Stage) prepends
 * the profile's static role preamble (loaded by PromptLoader) before this
 * dynamic section.
 *
 * The context policy controls token budget: `graphView` picks the rendering
 * strategy, `maxFacts` caps fact count, `includeDeadEnds` and `includeProgress`
 * toggle optional blocks. `rotateOnContextFull` is a signal the metacog
 * supervisor reads to decide whether to rotate the run when context exceeds a
 * threshold.
 */

import type { ContextSpec, Fact, Hint, Intent, Progress, Verdict, ProjectId } from "./types.js";
import type { Graph } from "../graph/graph.js";
import { renderGraphView, type GraphViewInput, type GraphViewOptions } from "./graph-view.js";

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
    if (rootIds.length > 0) {
      passFacts = filterRelevantFacts(graph, projectId, passFacts, rootIds, 2);
    }
  }

  const input: GraphViewInput = {
    passFacts,
    denyFacts: graph.facts(projectId, "deny"),
    pendingFacts: graph.facts(projectId, "pending"),
    openIntents: graph.intents(projectId, "open"),
    claimedIntents: graph.intents(projectId, "claimed"),
    target: project?.target,
    goal: project?.goal,
    progress: viewOptions.includeProgress ? graph.progress(projectId) : undefined,
    recentVerdicts: options.recentVerdicts,
    hints: options.hints?.map((h) => ({
      id: h.id, content: h.content, creator: h.creator,
      kind: h.kind, targetIntentId: h.targetIntentId,
    })),
  };

  return renderGraphView(input, viewOptions);
}

function collectRootFactIds(options: BuildContextOptions): string[] {
  const ids = new Set<string>();
  if (options.intent) {
    for (const id of options.intent.parentFactIds) ids.add(id);
  }
  if (options.candidate?.parentIntentId) {
    const intent = options.graph.getIntent(options.projectId, options.candidate.parentIntentId);
    if (intent) {
      for (const id of intent.parentFactIds) ids.add(id);
    }
  }
  return [...ids];
}

function filterRelevantFacts(
  graph: Graph,
  projectId: ProjectId,
  allFacts: Fact[],
  rootFactIds: string[],
  maxHops: number,
): Fact[] {
  const relevant = new Set(rootFactIds);
  // An Intent IS the graph edge (parentFactIds → concludedFactId). Traverse
  // concluded intents to find facts connected to the roots — same BFS that Link
  // used to do, now derived from the Intent edges themselves.
  const edges = graph.intents(projectId).filter((i) => i.concludedFactId);

  for (let hop = 0; hop < maxHops; hop++) {
    const frontier = [...relevant];
    for (const intent of edges) {
      const fromIds = intent.parentFactIds;
      const toId = intent.concludedFactId!;
      // forward: from a frontier fact to its conclusion
      if (fromIds.some((id) => frontier.includes(id)) && !relevant.has(toId)) {
        relevant.add(toId);
      }
      // reverse: from a conclusion back to its sources
      if (frontier.includes(toId)) {
        for (const id of fromIds) {
          if (!relevant.has(id)) relevant.add(id);
        }
      }
    }
  }

  const filtered = allFacts.filter((f) => relevant.has(f.id));
  if (filtered.length < allFacts.length) return filtered;

  const recent = allFacts.slice(-5);
  const seen = new Set(filtered.map((f) => f.id));
  for (const f of recent) {
    if (!seen.has(f.id)) filtered.push(f);
  }
  return filtered;
}

/**
 * Estimate whether the rendered context is "full" (approaching token limits).
 * The metacog supervisor uses this to decide whether to rotate the run when
 * `rotateOnContextFull` is enabled.
 */
export function estimateContextTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for mixed prose/code.
  return Math.ceil(text.length / 4);
}

export function isContextNearFull(text: string, threshold = 8000): boolean {
  return estimateContextTokens(text) >= threshold;
}
