/**
 * Output contract validators.
 *
 * Each named contract (main_decision, candidate_fact, verdict, hints, stop)
 * has a dedicated validator that takes a parsed WorkerEnvelope and
 * returns a typed, validated payload — or throws on shape mismatch.
 *
 * The subagent runner and decision applier share these validators, so output
 * enforcement is centralized.
 */

import type { BroadcastAssessment, Verdict } from "./types.js";
import type { HintInput } from "../graph/graph.js";
import {
  asArray,
  asBoolean,
  asNumber,
  asOptionalString,
  asString,
  expectKind,
  type WorkerEnvelope,
} from "./parse-envelope.js";
import { StageError } from "./parse-envelope.js";

// ─── main_decision (planner output) ───

export interface MainDecisionIntent {
  description: string;
  parentFactIds?: string[];
  priority?: number;
  /** Explicit planner request to create an explorer for this Intent. */
  dispatchExplorer: boolean;
}

export interface MainDecisionFail {
  intentId: string;
  reason: string;
}

export interface MainDecision {
  createIntents: MainDecisionIntent[];
  dispatchExplorerIntentIds: string[];
  stopExplorerIntentIds: string[];
  failIntents: MainDecisionFail[];
  consumeHintIds: string[];
  concludeRun?: { description: string; fromFactIds?: string[] };
}

export function validateMainDecision(envelope: WorkerEnvelope): MainDecision {
  const data = expectKind(envelope, "decisions", "planner");

  const createRaw = asArray(data, "createIntents", "planner") as Array<Record<string, unknown>>;
  const createIntents: MainDecisionIntent[] = createRaw.map((raw) => ({
    description: asString(raw, "description", "planner"),
    parentFactIds: Array.isArray(raw.from) ? (raw.from as string[]) : undefined,
    priority: typeof raw.priority === "number" ? raw.priority : undefined,
    dispatchExplorer: asBoolean(raw, "dispatchExplorer", "planner"),
  }));

  const dispatchRaw = Array.isArray(data.dispatchExplorerIntentIds)
    ? data.dispatchExplorerIntentIds
    : [];
  const dispatchExplorerIntentIds = dispatchRaw.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  const stopRaw = Array.isArray(data.stopExplorerIntentIds)
    ? data.stopExplorerIntentIds
    : [];
  const stopExplorerIntentIds = stopRaw.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  const failRaw = (Array.isArray(data.failIntents) ? data.failIntents : []) as Array<Record<string, unknown>>;
  const failIntents: MainDecisionFail[] = failRaw.map((raw) => ({
    intentId: asString(raw, "intentId", "planner"),
    reason: asString(raw, "reason", "planner"),
  }));

  const concludeRaw = data.concludeRun as Record<string, unknown> | undefined;
  const concludeRun = concludeRaw && typeof concludeRaw.description === "string"
    ? {
        description: concludeRaw.description,
        fromFactIds: Array.isArray(concludeRaw.from)
          ? concludeRaw.from.filter((value): value is string => typeof value === "string" && value.length > 0)
          : undefined,
      }
    : undefined;

  const consumeRaw = Array.isArray(data.consumeHints) ? data.consumeHints : [];
  const consumeHintIds = consumeRaw.filter((v): v is string => typeof v === "string" && v.length > 0);

  return {
    createIntents,
    dispatchExplorerIntentIds,
    stopExplorerIntentIds,
    failIntents,
    consumeHintIds,
    concludeRun,
  };
}

// ─── candidate_fact (explorer output) ───

export interface CandidateFact {
  description: string;
  evidence: string[];
  confidence: number;
}

export function validateCandidateFact(envelope: WorkerEnvelope, stage: string): CandidateFact {
  const data = expectKind(envelope, "fact", stage);
  return {
    description: asString(data, "description", stage),
    evidence: Array.isArray(data.evidence) ? (data.evidence as string[]) : [],
    confidence: asNumber(data, "confidence", stage, 0.7),
  };
}

// ─── verdict (evaluator output) ───

export function validateVerdict(envelope: WorkerEnvelope, stage: string): Verdict {
  const data = expectKind(envelope, "verdict", stage);
  const decisionRaw = asString(data, "decision", stage);
  if (decisionRaw !== "pass" && decisionRaw !== "deny" && decisionRaw !== "pending") {
    throw new StageError(
      `verdict decision must be accept|reject|defer, got: ${decisionRaw}`,
      stage,
    );
  }
  const reason = asString(data, "reason", stage);
  const confidenceRaw = data.confidence;
  const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw) ? confidenceRaw : undefined;
  const requiredConditions = Array.isArray(data.requiredConditions)
    ? (data.requiredConditions as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
    : undefined;
  return { decision: decisionRaw, reason, confidence, requiredConditions };
}

// ─── broadcast_assessment (evaluator receives a FactBroadcast) ───

export function validateBroadcastAssessment(
  envelope: WorkerEnvelope,
  stage: string,
): BroadcastAssessment {
  const data = expectKind(envelope, "broadcast_assessment", stage);
  const decision = asString(data, "decision", stage);
  if (decision !== "relevant" && decision !== "irrelevant" && decision !== "condition_satisfied") {
    throw new StageError(
      `broadcast assessment decision must be relevant|irrelevant|condition_satisfied, got: ${decision}`,
      stage,
    );
  }
  const targetFactId = asOptionalString(data, "targetFactId");
  if (decision === "condition_satisfied" && !targetFactId) {
    throw new StageError("condition_satisfied requires targetFactId", stage);
  }
  return {
    decision,
    reason: asString(data, "reason", stage),
    targetFactId,
  };
}

// ─── hints (metacog output) ───

export function validateHints(envelope: WorkerEnvelope, stage: string, creator: string): { hints: HintInput[] } {
  const data = expectKind(envelope, "hints", stage);
  const hintsRaw = asArray(data, "hints", stage) as Array<Record<string, unknown>>;
  const hints: HintInput[] = hintsRaw.map((raw) => ({
    content: asString(raw, "content", stage),
    creator: creator as HintInput["creator"],
  }));
  return { hints };
}

// ─── stop (metacog output) ───

export function validateStop(envelope: WorkerEnvelope, stage: string): { reason: string } {
  const data = expectKind(envelope, "stop", stage);
  return { reason: asString(data, "reason", stage) };
}
