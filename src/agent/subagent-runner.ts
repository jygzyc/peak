/**
 * SubagentRunner — universal execution engine for all subagent profiles.
 *
 * Replaces the four hardcoded stage files (planner/explorer/evaluator/metacog).
 * The runner is role-agnostic: it assembles a prompt from (1) the profile's
 * compiled or external system prompt, (2) dynamic graph context via
 * ContextBuilder, and (3) a
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
  RunId,
  PromptManifest,
  Project,
  SubagentRun,
} from "./types.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { parseEnvelope, StageError, type WorkerEnvelope } from "./parse-envelope.js";
import {
  validateCandidateFact,
  validateHints,
  validateMainDecision,
  validateStop,
  validateVerdict,
  validateBroadcastAssessment,
  type CandidateFact,
  type MainDecision,
} from "./contracts.js";
import {
  materializeGraphContext,
  materializeRoleOutput,
  renderGraphContextArtifact,
  type SessionGraphReader,
} from "./context-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { PromptBuilder } from "./prompt-builder.js";
export {
  plannerExtra,
  explorerExtra,
  evaluatorExtra,
  broadcastEvaluatorExtra,
  metacogExtra,
} from "./prompt-builder.js";
export type { SiblingInsight } from "./prompt-builder.js";

export type SubagentRunUpdate = Partial<Pick<SubagentRun,
  "promptHash" | "promptManifest" | "contextArtifact" | "outputArtifact" | "workerSessionId"
>>;

export interface SubagentRunRequest {
  profile: SubagentProfile;
  profileId: string;
  project: Project;
  workerPool: WorkerPool;
  config: TaskConfig;
  promptExtra: string;
  hints?: Hint[];
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  promptLoader?: PromptLoader;
  graphReader: SessionGraphReader;
  workerNameOverride?: WorkerName;
  intent?: import("./types.js").Intent;
  candidate?: Fact;
  /** Persist prompt provenance onto this already-created SubagentRun. */
  runId: RunId;
  /** Control-plane callback. Role execution never receives a Graph/database handle. */
  onRunUpdate?: (patch: SubagentRunUpdate) => void;
  /** Propagates a directive/runtime cancellation to the worker transport. */
  signal?: AbortSignal;
}

export type SubagentOutput =
  | { kind: "decisions"; decision: MainDecision }
  | { kind: "fact"; fact: CandidateFact }
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "broadcast_assessment"; assessment: import("./types.js").BroadcastAssessment }
  | { kind: "hints"; hints: ReturnType<typeof validateHints> }
  | { kind: "stop"; stop: ReturnType<typeof validateStop> };

export function runSubagent(req: SubagentRunRequest): Promise<SubagentOutput> {
  return runSubagentWithText(req).then((r) => r.output);
}

export interface SubagentRunWithTextResult {
  output: SubagentOutput;
  rawText: string;
  prompt: string;
  /** True when the output came from a conclude-fallback retry (first call failed to parse). */
  usedConclude?: boolean;
  promptHash: string;
  promptManifest: PromptManifest;
}

export async function runSubagentWithText(req: SubagentRunRequest): Promise<SubagentRunWithTextResult> {
  const { profile, project, workerPool, config, promptExtra } = req;
  const projectId = project.id;
  const workerName = req.workerNameOverride
    ?? selectProfileWorker(profile, projectId, workerPool, config);
  const workerConfig = config.workers[workerName];
  if (!workerConfig) {
    throw new StageError(`worker config missing for ${profile.role}: ${workerName}`, profile.role);
  }
  if (workerConfig.kind === "api") {
    throw new StageError(
      `role worker "${workerName}" cannot read session JSON artifacts; use an agent worker`,
      profile.role,
    );
  }

  const loader = req.promptLoader ?? new PromptLoader({ baseDir: project.sessionDir });
  const promptBuilder = new PromptBuilder(loader);
  const resolved = promptBuilder.resolve(profile.prompt);
  if (!resolved.fromConfig) {
    throw new StageError(
      `prompt file not loaded for profile "${req.profileId}". Ensure prompt.file points to an existing file.`,
      profile.role,
    );
  }

  const recentVerdicts = req.recentVerdicts ?? [];
  const snapshot = await req.graphReader.readSnapshot({
    sessionId: project.session, projectId, spec: profile.context,
    profileId: req.profileId,
    hints: req.hints, recentVerdicts,
    intent: req.intent, candidate: req.candidate,
    signal: req.signal,
  });

  const contextArtifact = await materializeGraphContext(project.sessionDir, req.runId, snapshot);
  const contextBlock = renderGraphContextArtifact(snapshot, contextArtifact);
  const contextComponent = {
    source: `artifact:${contextArtifact.relativePath}`,
    resolvedPath: contextArtifact.resolvedPath,
    graphSeq: snapshot.graphSeq,
    artifactSha256: contextArtifact.sha256,
    delivery: contextArtifact.delivery,
  };
  const assignmentBlock = promptExtra || [
    "## Assignment",
    `Execute the current ${profile.role} responsibility for project ${projectId}.`,
  ].join("\n");
  const outputContractBlock = [
    "## Output Contract Binding",
    `Contract: ${profile.output.contract}`,
    "Return one response that conforms to the contract declared by the role system prompt.",
  ].join("\n");
  const builtPrompt = promptBuilder.compose(
    resolved,
    contextBlock,
    assignmentBlock,
    contextComponent,
    outputContractBlock,
  );
  const { prompt, promptHash } = builtPrompt;
  req.onRunUpdate?.({ promptHash, promptManifest: builtPrompt.manifest, contextArtifact });

  const result = await workerPool.execute({
    prompt,
    config: workerConfig,
    workerName,
    role: profile.role,
    projectId,
    // Persistent runtime state and the user workspace are distinct. Coding
    // agents inspect the configured workspace; graph/session DB files remain in
    // sessionDir and are never exposed as a substitute task target.
    cwd: project.workspaceDir,
    maxOutputTokens: profile.maxOutputTokens,
    signal: req.signal,
  });

  if (result.returncode !== 0) {
    throw new StageError(
      `${profile.role} worker failed: ${result.stderr ?? "no stderr"}`,
      profile.role,
    );
  }

  persistWorkerSessionId(req, result.sessionId);

  // Conclude fallback: if the worker returned (returncode 0) but its output fails
  // to parse into a valid envelope, re-invoke the worker in the same session with
  // a conclude prompt that forces it to summarize already-confirmed findings into
  // the required JSON shape. Modeled on Cairn's conclude phase. Only triggers for
  // profiles that declare prompt.concludeFile.
  try {
    const envelope = parseEnvelope(result.text, profile.role);
    const output = validateOutput(envelope, profile, req.profileId);
    await persistRoleOutput(req, output);
    return {
      output,
      rawText: result.text,
      prompt,
      promptHash,
      promptManifest: builtPrompt.manifest,
    };
  } catch (parseErr) {
    if (req.signal?.aborted) throw parseErr;
    const concludeFile = profile.prompt.concludeFile;
    if (!concludeFile) throw parseErr;

    // Load the conclude preamble and re-invoke the worker in the same session
    // (when the backend supports resume; sessionId propagates through the pool).
    const concludePromptExtra = [
      assignmentBlock,
      `## Prior Worker Output (first attempt, failed to parse)\n${result.text.slice(0, 4000)}`,
    ].filter(Boolean).join("\n\n");
    const concludeBuilt = promptBuilder.build({
      spec: { file: concludeFile },
      primaryKind: "conclude",
      context: contextBlock,
      extra: concludePromptExtra,
      contextComponent,
      outputContract: outputContractBlock,
    });
    if (!concludeBuilt.fromConfig) throw parseErr;
    const concludePrompt = concludeBuilt.prompt;
    const concludePromptHash = concludeBuilt.promptHash;
    req.onRunUpdate?.({ promptHash: concludePromptHash, promptManifest: concludeBuilt.manifest });

    const concludeResult = await workerPool.execute({
      prompt: concludePrompt,
      config: workerConfig,
      workerName,
      role: profile.role,
      projectId,
      cwd: project.workspaceDir,
      maxOutputTokens: profile.maxOutputTokens,
      sessionId: result.sessionId,
      conclude: true,
      signal: req.signal,
    });

    if (concludeResult.returncode !== 0) throw parseErr;

    persistWorkerSessionId(req, concludeResult.sessionId ?? result.sessionId);

    const concludeEnvelope = parseEnvelope(concludeResult.text, profile.role);
    const concludeOutput = validateOutput(concludeEnvelope, profile, req.profileId);
    await persistRoleOutput(req, concludeOutput);
    return {
      output: concludeOutput,
      rawText: concludeResult.text,
      prompt: concludePrompt,
      usedConclude: true,
      promptHash: concludePromptHash,
      promptManifest: concludeBuilt.manifest,
    };
  }
}

function persistWorkerSessionId(req: SubagentRunRequest, sessionId: string | undefined): void {
  if (sessionId) req.onRunUpdate?.({ workerSessionId: sessionId });
}

async function persistRoleOutput(req: SubagentRunRequest, output: SubagentOutput): Promise<void> {
  const artifact = await materializeRoleOutput(
    req.project.sessionDir,
    req.project.session,
    req.project.id,
    req.runId,
    req.profile.role,
    output,
  );
  req.onRunUpdate?.({ outputArtifact: artifact });
}

export function selectProfileWorker(
  profile: SubagentProfile,
  projectId: ProjectId,
  workerPool: WorkerPool,
  config: TaskConfig,
): WorkerName {
  const candidates = [...new Set(
    profile.runtime.workers?.length
      ? profile.runtime.workers
      : [profile.runtime.worker],
  )].filter((name) => config.workers[name]);
  if (candidates.length === 0) {
    throw new StageError(`no configured worker is available for ${profile.role}`, profile.role);
  }
  const selected = workerPool.pickWorker(projectId, config, candidates);
  return candidates.includes(selected) ? selected : candidates[0]!;
}

const CONTRACT_KIND_MAP: Record<string, Set<string>> = {
  main_decision: new Set(["decisions"]),
  candidate_fact: new Set(["fact"]),
  verdict: new Set(["verdict"]),
  broadcast_assessment: new Set(["broadcast_assessment"]),
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
    case "broadcast_assessment":
      return { kind: "broadcast_assessment", assessment: validateBroadcastAssessment(envelope, stage) };
    case "hints":
      return { kind: "hints", hints: validateHints(envelope, stage, profile.role) };
    case "stop":
      return { kind: "stop", stop: validateStop(envelope, stage) };
    default:
      throw new StageError(
        `unexpected envelope kind "${envelope.kind}" for profile "${profileId}"`,
        stage,
      );
  }
}
