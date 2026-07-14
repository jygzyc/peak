/**
 * SubagentRunner — universal execution engine for all subagent profiles.
 *
 * Replaces the four hardcoded stage files (planner/explorer/evaluator/metacog).
 * The runner is role-agnostic: it assembles a prompt from (1) the profile's
 * prompt file, (2) dynamic graph context via ContextBuilder, and (3) a
 * role-specific extra block provided by the caller. It then calls the worker,
 * parses the envelope, and validates the output via the named contract.
 *
 * The caller (SessionLoop / MainAgent / MetacogSupervisor) supplies the
 * role-specific promptExtra (e.g. "## Current Intent\n..." for explorer,
 * "## Candidate Under Review\n..." for evaluator) and pattern-matches on the
 * returned discriminated union to apply graph mutations.
 */

import type {
  Fact,
  Hint,
  ProjectId,
  SubagentProfile,
  TaskConfig,
  Verdict,
  WorkerName,
} from "./types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { parseEnvelope, StageError, type WorkerEnvelope } from "./parse-envelope.js";
import {
  validateCandidateFact,
  validateHints,
  validateMainDecision,
  validateStop,
  validateVerdict,
  type CandidateFact,
  type MainDecision,
} from "./contracts.js";
import { buildDynamicContext } from "./context-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { ContextLedger } from "./context-ledger.js";
import type { WorkerSessionManager } from "../worker/session-manager.js";

export interface SubagentRunRequest {
  profile: SubagentProfile;
  profileId: string;
  projectId: ProjectId;
  graph: Graph;
  workerPool: WorkerPool;
  config: TaskConfig;
  promptExtra: string;
  hints?: Hint[];
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  promptLoader?: PromptLoader;
  workerNameOverride?: WorkerName;
  contextLedger?: ContextLedger;
  sessionManager?: WorkerSessionManager;
  intent?: import("./types.js").Intent;
  candidate?: Fact;
}

export type SubagentOutput =
  | { kind: "decisions"; decision: MainDecision }
  | { kind: "fact"; fact: CandidateFact }
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "hints"; hints: ReturnType<typeof validateHints> }
  | { kind: "stop"; stop: ReturnType<typeof validateStop> };

export function runSubagent(req: SubagentRunRequest): Promise<SubagentOutput> {
  return runSubagentWithText(req).then((r) => r.output);
}

export interface SubagentRunWithTextResult {
  output: SubagentOutput;
  rawText: string;
  prompt: string;
  usedDelta: boolean;
  /** True when the output came from a conclude-fallback retry (first call failed to parse). */
  usedConclude?: boolean;
}

export async function runSubagentWithText(req: SubagentRunRequest): Promise<SubagentRunWithTextResult> {
  const { profile, projectId, graph, workerPool, config, promptExtra } = req;

  const project = graph.getProject(projectId);
  if (!project) throw new StageError(`project not found: ${projectId}`, profile.role);

  const workerName = req.workerNameOverride
    ?? profile.runtime.workers?.[0]
    ?? profile.runtime.worker;
  const workerConfig = config.workers[workerName];
  if (!workerConfig) {
    throw new StageError(`worker config missing for ${profile.role}: ${workerName}`, profile.role);
  }

  const loader = req.promptLoader ?? new PromptLoader({ baseDir: project.sessionDir });
  const resolved = loader.load(profile.prompt);
  if (!resolved.fromConfig) {
    throw new StageError(
      `prompt file not loaded for profile "${req.profileId}". Ensure prompt.file points to an existing file.`,
      profile.role,
    );
  }

  const useSession = profile.sessionReuse === true;
  const ledger = useSession ? req.contextLedger : undefined;
  const recentVerdicts = req.recentVerdicts ?? [];

  let contextBlock: string;
  let usedDelta = false;

  if (ledger && useSession) {
    const delta = ledger.computeDelta(projectId, req.profileId, graph, recentVerdicts);
    if (delta.isDelta) {
      contextBlock = delta.deltaBlock;
      usedDelta = true;
    } else {
      contextBlock = buildDynamicContext({
        projectId, graph, spec: profile.context,
        hints: req.hints, recentVerdicts,
        intent: req.intent, candidate: req.candidate,
      });
    }
  } else {
    contextBlock = buildDynamicContext({
      projectId, graph, spec: profile.context,
      hints: req.hints, recentVerdicts,
      intent: req.intent, candidate: req.candidate,
    });
  }

  const prompt = [resolved.preamble, contextBlock, promptExtra].filter(Boolean).join("\n\n");

  const result = await workerPool.execute({
    prompt,
    config: workerConfig,
    workerName,
    role: profile.role,
    projectId,
    // Run the worker in the session directory (an isolated workspace), NOT the
    // caller's cwd. Without this, coding-agent workers (opencode, claude) scan
    // the host project directory and treat it as the task context, ignoring the
    // prompt's actual instructions.
    cwd: project.sessionDir,
    maxOutputTokens: profile.maxOutputTokens,
    sessionId: useSession && req.sessionManager
      ? req.sessionManager.get(projectId, req.profileId)?.sessionId
      : undefined,
  });

  if (result.returncode !== 0) {
    throw new StageError(
      `${profile.role} worker failed: ${result.stderr ?? "no stderr"}`,
      profile.role,
    );
  }

  if (ledger && useSession) {
    const progress = graph.progress(projectId);
    ledger.sync(projectId, req.profileId, graph, recentVerdicts, progress);
  }

  // Conclude fallback: if the worker returned (returncode 0) but its output fails
  // to parse into a valid envelope, re-invoke the worker in the same session with
  // a conclude prompt that forces it to summarize already-confirmed findings into
  // the required JSON shape. Modeled on Cairn's conclude phase. Only triggers for
  // profiles that declare prompt.concludeFile.
  try {
    const envelope = parseEnvelope(result.text, profile.role);
    const output = validateOutput(envelope, profile, req.profileId);
    return { output, rawText: result.text, prompt, usedDelta };
  } catch (parseErr) {
    const concludeFile = profile.prompt.concludeFile;
    if (!concludeFile) throw parseErr;

    // Load the conclude preamble and re-invoke the worker in the same session
    // (when the backend supports resume; sessionId propagates through the pool).
    const concludeResolved = loader.load({ file: concludeFile });
    if (!concludeResolved.fromConfig) throw parseErr;
    const concludePromptExtra = [
      promptExtra,
      `## Prior Worker Output (first attempt, failed to parse)\n${result.text.slice(0, 4000)}`,
    ].filter(Boolean).join("\n\n");
    const concludePrompt = [concludeResolved.preamble, contextBlock, concludePromptExtra]
      .filter(Boolean).join("\n\n");

    const concludeResult = await workerPool.execute({
      prompt: concludePrompt,
      config: workerConfig,
      workerName,
      role: profile.role,
      projectId,
      cwd: project.sessionDir,
      maxOutputTokens: profile.maxOutputTokens,
      sessionId: result.sessionId,
      conclude: true,
    });

    if (concludeResult.returncode !== 0) throw parseErr;

    const concludeEnvelope = parseEnvelope(concludeResult.text, profile.role);
    const concludeOutput = validateOutput(concludeEnvelope, profile, req.profileId);
    return {
      output: concludeOutput,
      rawText: concludeResult.text,
      prompt: concludePrompt,
      usedDelta,
      usedConclude: true,
    };
  }
}

const CONTRACT_KIND_MAP: Record<string, Set<string>> = {
  main_decision: new Set(["decisions"]),
  candidate_fact: new Set(["fact"]),
  verdict: new Set(["verdict"]),
  hints: new Set(["hints", "stop"]),
};

function validateOutput(
  envelope: WorkerEnvelope,
  profile: SubagentProfile,
  profileId: string,
): SubagentOutput {
  const stage = profile.role;
  const contract = profile.output.contract;
  const allowed = CONTRACT_KIND_MAP[contract];
  if (allowed && !allowed.has(envelope.kind)) {
    throw new StageError(
      `profile "${profileId}" (contract="${contract}") returned kind="${envelope.kind}", expected one of: ${[...allowed].join(", ")}`,
      stage,
    );
  }
  switch (envelope.kind) {
    case "decisions":
      return { kind: "decisions", decision: validateMainDecision(envelope) };
    case "fact":
      return { kind: "fact", fact: validateCandidateFact(envelope, stage) };
    case "verdict":
      return { kind: "verdict", verdict: validateVerdict(envelope, stage) };
    case "hints":
      return { kind: "hints", hints: validateHints(envelope, stage, profileId) };
    case "stop":
      return { kind: "stop", stop: validateStop(envelope, stage) };
    default:
      throw new StageError(
        `unexpected envelope kind "${envelope.kind}" for profile "${profileId}"`,
        stage,
      );
  }
}

/**
 * Build the role-specific promptExtra block for each builtin role.
 * Callers use these to avoid duplicating formatting logic.
 */

export function plannerExtra(
  hints?: Hint[],
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>,
): string {
  const lines: string[] = [];

  if (hints && hints.length > 0) {
    lines.push("## Hints Requiring Response");
    lines.push(
      "For each hint: create a new intent pursuing it, fail an existing intent whose direction " +
        "it contradicts, or ignore if irrelevant. A stop-explorer hint means: fail the targeted intent.",
    );
    for (const h of hints) {
      const tgt = h.targetIntentId ? ` (target: ${h.targetIntentId})` : "";
      lines.push(`- [${h.id}] (${h.kind}, from ${h.creator})${tgt}: ${h.content}`);
    }
  }

  if (recentVerdicts && recentVerdicts.length > 0) {
    lines.push("## Recent Evaluator Verdicts");
    lines.push(
      "If a candidate was rejected, decide whether its intent should be failed (dead-end confirmed), " +
        "retried differently, or replaced. If accepted, decide what to investigate next.",
    );
    for (const v of recentVerdicts) {
      lines.push(`- ${v.factId} (${v.intentId ?? "no intent"}): ${v.verdict.decision} — ${v.verdict.reason}`);
    }
  }

  return lines.join("\n");
}

export function explorerExtra(
  intentId: string,
  intentDescription: string,
  parentFactIds: string[],
  insights: Fact[],
): string {
  const lines: string[] = [];
  if (insights.length > 0) {
    lines.push("## Recent Discoveries by Other Explorers");
    lines.push("These facts were just discovered by parallel explorers. Use them — avoid duplicating their work.");
    for (const f of insights) lines.push(`- ${f.id}: ${f.description}`);
  }
  lines.push("## Current Intent");
  lines.push(`ID: ${intentId}`);
  lines.push(`Description: ${intentDescription}`);
  if (parentFactIds.length > 0) {
    lines.push(`Triggered by facts: ${parentFactIds.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * A cross-session insight surfaced to the evaluator as read-only corroboration.
 * Federation facts never enter the local graph — they are shown to the evaluator
 * so it can cross-validate a local candidate against what siblings have already
 * verified or ruled out, saving redundant local verification work.
 */
export interface SiblingInsight {
  summary: string;
  confidence: number;
  fromSession: string;
}

export function evaluatorExtra(
  candidate: Fact,
  siblingFacts?: SiblingInsight[],
  siblingDeadEnds?: SiblingInsight[],
): string {
  const lines: string[] = ["## Candidate Fact Under Review"];
  lines.push(`ID: ${candidate.id}`);
  lines.push(`Description: ${candidate.description}`);
  lines.push(`Confidence claimed: ${candidate.confidence}`);

  if (siblingFacts && siblingFacts.length > 0) {
    lines.push("## Cross-session Corroboration (VERIFIED by other sessions)");
    lines.push(
      "Other sessions have VERIFIED these facts. Use them as supporting evidence — " +
        "if this candidate is corroborated by any of them, you may accept with higher confidence.",
    );
    for (const f of siblingFacts) {
      lines.push(`- [session ${f.fromSession}, conf ${f.confidence}] ${f.summary}`);
    }
  }

  if (siblingDeadEnds && siblingDeadEnds.length > 0) {
    lines.push("## Cross-session Dead-ends (RULED OUT by other sessions)");
    lines.push(
      "Other sessions ruled OUT these paths. If this candidate aligns with a ruled-out " +
        "direction, reject it unless you have strong independent evidence.",
    );
    for (const d of siblingDeadEnds) {
      lines.push(`- [session ${d.fromSession}] ${d.summary}`);
    }
  }

  if (candidate.evidence.length > 0) {
    lines.push("Evidence:");
    for (const e of candidate.evidence) lines.push(`- ${e}`);
  }
  return lines.join("\n");
}

export function metacogExtra(trigger: string): string {
  return `## Trigger\nThis metacog run was triggered by: ${trigger}`;
}
