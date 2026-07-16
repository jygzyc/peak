/**
 * Graph view rendering — controls how much of the session graph appears in a
 * subagent's prompt.
 *
 * Profiles declare a `context.graphView` policy:
 *   - full:          all verified facts, rejected facts, intents, hints
 *   - focused:       verified facts (capped) + recent rejected facts + relevant intents
 *   - evidence-only: only verified facts with evidence, no intents or hints
 *   - summary:       fact counts + intent counts + recent verdicts, no fact bodies
 *
 * `maxFacts` caps the number of facts rendered (oldest trimmed first) to bound
 * prompt size on long runs.
 */

import type { Fact, GraphView, Intent, Progress, Verdict } from "./types.js";

export interface GraphViewInput {
  passFacts: Fact[];
  denyFacts?: Fact[];
  candidateFacts?: Fact[];
  pendingFacts?: Fact[];
  openIntents?: Intent[];
  claimedIntents?: Intent[];
  hints?: Array<{ id: string; content: string; creator: string; kind: string; targetIntentId?: string }>;
  progress?: Progress;
  /** The project target/goal — always rendered first so the planner knows the task. */
  target?: string;
  goal?: string;
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  broadcastAssessments?: Array<{
    broadcastId: string;
    decision: string;
    reason: string;
    targetFactId?: string;
  }>;
}

export interface GraphViewOptions {
  view: GraphView;
  maxFacts?: number;
  includeDeadEnds?: boolean;
  includeProgress?: boolean;
}

export function renderGraphView(input: GraphViewInput, options: GraphViewOptions): string {
  switch (options.view) {
    case "full":
      return renderFull(input, options);
    case "focused":
      return renderFocused(input, options);
    case "evidence-only":
      return renderEvidenceOnly(input, options);
    case "summary":
      return renderSummary(input, options);
    default:
      return renderFull(input, options);
  }
}

function cap<T>(items: T[], max: number | undefined): T[] {
  if (max === undefined || items.length <= max) return items;
  return items.slice(items.length - max);
}

function renderFull(input: GraphViewInput, options: GraphViewOptions): string {
  const sections: string[] = renderObjective(input);
  const denyFacts = input.denyFacts ?? [];

  if (options.includeProgress && input.progress) {
    sections.push(renderProgressBlock(input.progress));
  }

  if (input.passFacts.length > 0) {
    sections.push("## Passed Facts");
    for (const f of cap(input.passFacts, options.maxFacts)) {
      sections.push(`- ${fmtFact(f)}`);
    }
  }

  if (options.includeDeadEnds !== false && denyFacts.length > 0) {
    sections.push("## Denied Facts (dead-ends)");
    for (const f of cap(denyFacts, 10)) {
      sections.push(`- ${f.id}: ${f.description} — ${f.reviewerReason ?? "deny"}`);
    }
  }

  if (input.candidateFacts && input.candidateFacts.length > 0) {
    sections.push("## Candidate Facts (awaiting evaluator)");
    for (const f of cap(input.candidateFacts, 10)) {
      sections.push(`- ${fmtFact(f)}`);
    }
  }

  if (input.pendingFacts && input.pendingFacts.length > 0) {
    sections.push("## Pending Facts (conditions missing)");
    for (const f of cap(input.pendingFacts, 10)) {
      const conditions = f.requiredConditions?.join(", ") || "unspecified";
      sections.push(`- ${f.id}: ${f.description} — waiting for: ${conditions}`);
    }
  }

  const intents = [
    ...(input.openIntents ?? []),
    ...(input.claimedIntents ?? []),
  ];
  if (intents.length > 0) {
    sections.push("## Current Intents");
    for (const i of input.openIntents ?? []) sections.push(`- [open] ${i.id}: ${i.description}`);
    for (const i of input.claimedIntents ?? []) sections.push(`- [claimed] ${i.id}: ${i.description}`);
  }

  if (input.hints && input.hints.length > 0) {
    sections.push("## Hints");
    for (const h of input.hints) {
      sections.push(`- [${h.id}] (${h.kind}, from ${h.creator}): ${h.content}`);
    }
  }

  if (input.recentVerdicts && input.recentVerdicts.length > 0) {
    sections.push("## Recent Verdicts");
    for (const v of input.recentVerdicts) {
      sections.push(`- ${v.factId}: ${v.verdict.decision} — ${v.verdict.reason}`);
    }
  }

  if (input.broadcastAssessments && input.broadcastAssessments.length > 0) {
    sections.push("## Evaluated Cross-session Broadcasts");
    for (const assessment of input.broadcastAssessments) {
      const target = assessment.targetFactId ? `, target=${assessment.targetFactId}` : "";
      sections.push(
        `- ${assessment.broadcastId}: ${assessment.decision}${target} — ${assessment.reason}`,
      );
    }
  }

  return sections.join("\n");
}

function renderFocused(input: GraphViewInput, options: GraphViewOptions): string {
  const sections: string[] = renderObjective(input);
  const denyFacts = input.denyFacts ?? [];

  const ctx = input.passFacts;
  if (ctx.length > 0) {
    sections.push("## Context (passed facts)");
    for (const f of cap(ctx, options.maxFacts ?? 50)) {
      sections.push(`- ${fmtFact(f)}`);
    }
  }

  if (options.includeDeadEnds !== false && denyFacts.length > 0) {
    sections.push("## Known Dead-Ends");
    for (const f of cap(denyFacts, 10)) {
      sections.push(`- ${f.id}: ${f.description}${f.reviewerReason ? ` — ${f.reviewerReason}` : ""}`);
    }
  }

  return sections.join("\n");
}

function renderEvidenceOnly(input: GraphViewInput, options: GraphViewOptions): string {
  const sections: string[] = renderObjective(input);
  const withEvidence = input.passFacts.filter((f) => f.evidence.length > 0);
  if (withEvidence.length > 0) {
    sections.push("## Passed Facts (evidence)");
    for (const f of cap(withEvidence, options.maxFacts ?? 30)) {
      sections.push(`- ${f.id}: ${f.description}`);
      for (const e of f.evidence) sections.push(`  - ${e}`);
    }
  }
  return sections.join("\n");
}

function renderSummary(input: GraphViewInput, _options: GraphViewOptions): string {
  const sections: string[] = renderObjective(input);
  if (input.progress) {
    sections.push(renderProgressBlock(input.progress));
  } else {
    const rejectedCount = input.denyFacts?.length ?? 0;
    sections.push(`## Summary`);
    sections.push(`- Passed facts: ${input.passFacts.length}`);
    sections.push(`- Denied facts: ${rejectedCount}`);
  }

  if (input.recentVerdicts && input.recentVerdicts.length > 0) {
    sections.push("## Recent Verdicts");
    for (const v of input.recentVerdicts.slice(-5)) {
      sections.push(`- ${v.factId}: ${v.verdict.decision}`);
    }
  }
  return sections.join("\n");
}

function renderObjective(input: GraphViewInput): string[] {
  if (!input.target && !input.goal) return [];
  const lines = ["## Objective"];
  if (input.target) lines.push(`Target: ${input.target}`);
  if (input.goal) lines.push(`Goal: ${input.goal}`);
  return lines;
}

function renderProgressBlock(progress: Progress): string {
  const lines = [
    "## Progress",
    `- Passed facts: ${progress.passFacts}`,
    `- Candidate facts: ${progress.candidateFacts}`,
    `- Pending facts: ${progress.pendingFacts}`,
    `- Denied facts: ${progress.denyFacts}`,
    `- Open intents: ${progress.openIntents}`,
    `- Steps: ${progress.stepsExecuted}`,
    `- Stagnation: ${progress.stagnationLevel}`,
  ];
  return lines.join("\n");
}

function fmtFact(f: Fact): string {
  const conf = f.confidence < 1.0 ? ` (${Math.round(f.confidence * 100)}%)` : "";
  return `${f.id}${conf}: ${f.description}`;
}
