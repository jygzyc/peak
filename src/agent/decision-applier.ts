/**
 * Decision applier — translates a MainDecision into graph mutations.
 *
 * All mutations are wrapped in a single graph transaction for atomicity. If
 * any permission check fails mid-way, the transaction rolls back and no
 * partial mutations are persisted.
 *
 * The applier does NOT call workers; it only mutates the graph.
 */

import type { ProjectId, TaskConfig } from "./types.js";
import type { Graph } from "../graph/graph.js";
import type { MainDecision } from "./contracts.js";
import { PermissionChecker } from "./permissions.js";

export interface DecisionApplierResult {
  intentsCreated: number;
  explorersStopped: number;
  intentsFailed: number;
  hintsConsumed: number;
  concluded: boolean;
}

export interface ApplyDecisionContext {
  projectId: ProjectId;
  graph: Graph;
  config: TaskConfig;
  decision: MainDecision;
  permissions: PermissionChecker;
}

export function applyMainDecision(ctx: ApplyDecisionContext): DecisionApplierResult {
  const { projectId, graph, decision, permissions } = ctx;
  const result: DecisionApplierResult = {
    intentsCreated: 0,
    explorersStopped: 0,
    intentsFailed: 0,
    hintsConsumed: 0,
    concluded: false,
  };

  return graph.transaction(() => {
    // Existing open/claimed intent descriptions — used to drop near-duplicate
    // proposals so the planner can't flood the graph with reworded versions of
    // a direction already in flight (mechanical backstop for the prompt's
    // no-re-proposal rule; modeled on Muteki's _near_duplicate).
    const activeGoals = [
      ...graph.intents(projectId, "open"),
      ...graph.intents(projectId, "claimed"),
    ].map((i) => i.description);

    for (const spec of decision.createIntents) {
      permissions.require("create_intent");
      const dispatchExplorer = spec.dispatchExplorer ?? true;
      if (dispatchExplorer) permissions.require("create_subagent_explorer");
      if (graph.isDeadEnd(projectId, spec.description)) {
        graph.logEvent(projectId, "planner.dead_end_skipped", { description: spec.description });
        continue;
      }
      const dupOf = activeGoals.find((g) => nearDuplicateGoal(spec.description, g));
      if (dupOf) {
        graph.logEvent(projectId, "planner.duplicate_intent_dropped", {
          description: spec.description,
          duplicateOf: dupOf,
        });
        continue;
      }
      graph.addIntent(projectId, {
        description: spec.description,
        creator: "planner",
        parentFactIds: spec.parentFactIds,
        priority: spec.priority,
        dispatchRequested: dispatchExplorer,
      });
      activeGoals.push(spec.description);
      result.intentsCreated += 1;
    }

    for (const intentId of decision.dispatchExplorerIntentIds ?? []) {
      permissions.require("create_subagent_explorer");
      graph.requestExplorerDispatch(projectId, intentId);
    }

    for (const intentId of decision.stopExplorerIntentIds ?? []) {
      permissions.require("stop_subagent_explorer");
      try {
        graph.stopExplorer(projectId, intentId, "stopped by planner");
        result.explorersStopped += 1;
      } catch { /* intent may already be terminal */ }
    }

    for (const fail of decision.failIntents) {
      permissions.require("fail_intent");
      if (graph.getIntent(projectId, fail.intentId)?.status === "claimed") {
        permissions.require("stop_subagent_explorer");
      }
      try {
        graph.failIntent(projectId, fail.intentId, fail.reason, false, "planner");
        graph.logEvent(projectId, "planner.kill_explorer", { intentId: fail.intentId, reason: fail.reason });
        result.intentsFailed += 1;
      } catch { /* intent may already be concluded */ }
    }

    for (const hintId of decision.consumeHintIds) {
      try {
        graph.consumeHint(projectId, hintId);
        result.hintsConsumed += 1;
      } catch { /* already consumed */ }
    }

    if (decision.concludeRun) {
      permissions.require("create_end_fact");
      const fromFactIds = decision.concludeRun.fromFactIds ?? graph.facts(projectId, "pass").map((fact) => fact.id);
      graph.createEndFact(projectId, decision.concludeRun.description, fromFactIds);
      result.concluded = true;
    }

    return result;
  });
}

// ─── intent near-duplicate detection (planner backstop) ───

const GOAL_STOPWORDS = new Set((
  "the a an to of for on in at and or with via then into from by it its this " +
  "that these those please try attempt now next using use"
).split(" "));

/**
 * Normalize a goal/intent description to a comparable token bag: lowercase,
 * split on whitespace/punctuation (but NOT internal hyphens, so "TASK-A" stays
 * one token), English filler words removed. Two goals that differ only in
 * filler words collapse to the same (or near-same) form.
 */
function normalizeGoal(goal: string): string {
  const toks = goal.toLowerCase()
    .split(/[\s,;:!/?()[\]{}'"|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !GOAL_STOPWORDS.has(t));
  return toks.join(" ");
}

/**
 * True iff two goal descriptions are near-duplicates: identical after
 * filler-word normalization, or the same token bag (order-insensitive).
 * Deliberately conservative — only catches filler-word rewordings of a
 * direction already in flight, never paraphrases or short placeholder labels
 * (those are the planner prompt's job). A blank goal never matches.
 */
export function nearDuplicateGoal(a: string, b: string): boolean {
  const na = normalizeGoal(a);
  if (!na) return false;
  const nb = normalizeGoal(b);
  if (!nb) return false;
  if (na === nb) return true;
  const sa = new Set(na.split(" "));
  const sb = new Set(nb.split(" "));
  // same token bag (order-insensitive), but only when there is real content
  // (≥2 tokens) so short labels like "TASK-A" vs "TASK-B" don't collide.
  if (sa.size >= 2 && sb.size === sa.size && [...sa].every((t) => sb.has(t))) return true;
  return false;
}
