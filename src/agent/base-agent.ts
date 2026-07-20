import type {
  Fact,
  Hint,
  Intent,
  Project,
  PromptManifest,
  SubagentProfile,
  TaskConfig,
  Verdict,
  WorkerName,
} from "./types.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { parseEnvelope, StageError, type WorkerEnvelope } from "./parse-envelope.js";
import {
  validateBroadcastAssessment,
  validateCandidateFact,
  validateHints,
  validateMainDecision,
  outputContractInstructions,
  validateStop,
  validateVerdict,
  type CandidateFact,
  type MainDecision,
} from "./contracts.js";
import {
  materializeGraphContext,
  materializeRoleOutput,
  renderGraphContextArtifact,
  roleLogTimestamp,
  type SessionGraphReader,
} from "./context-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { PromptBuilder } from "./prompt-builder.js";

export interface BaseAgentContext {
  profile: SubagentProfile;
  profileId: string;
  project: Project;
  workerPool: WorkerPool;
  config: TaskConfig;
  graphReader: SessionGraphReader;
  promptLoader?: PromptLoader;
}

export interface BaseAgentRunInput {
  promptExtra: string;
  inputSummary?: string;
  hints?: Hint[];
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  workerName?: WorkerName;
  intent?: Intent;
  candidate?: Fact;
  signal?: AbortSignal;
  outputContract?: SubagentProfile["output"]["contract"];
}

export type AgentOutput =
  | { kind: "decisions"; decision: MainDecision }
  | { kind: "fact"; fact: CandidateFact }
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "broadcast_assessment"; assessment: import("./types.js").BroadcastAssessment }
  | { kind: "hints"; hints: ReturnType<typeof validateHints> }
  | { kind: "stop"; stop: ReturnType<typeof validateStop> };

export interface BaseAgentResult {
  output: AgentOutput;
  rawText: string;
  prompt: string;
  promptHash: string;
  promptManifest: PromptManifest;
}

/** Shared execution boundary for planner, explorer, evaluator and metacog. */
export class BaseAgent {
  constructor(protected readonly context: BaseAgentContext) {}

  protected async executeAgent(input: BaseAgentRunInput): Promise<BaseAgentResult> {
    const { profile, workerPool, config } = this.context;
    const workerName = input.workerName ?? selectProfileWorker(profile, workerPool, config);
    const workerConfig = config.workers[workerName];
    if (!workerConfig) throw new StageError(`worker config missing for ${profile.role}: ${workerName}`, profile.role);

    return this.execute(roleLogTimestamp(), workerName, input);
  }

  private async execute(
    logTimestamp: string,
    workerName: WorkerName,
    input: BaseAgentRunInput,
  ): Promise<BaseAgentResult> {
    const { profile, profileId, project, workerPool, config, graphReader } = this.context;
    const effectiveProfile = input.outputContract
      ? { ...profile, output: { contract: input.outputContract } }
      : profile;
    const workerConfig = config.workers[workerName]!;
    const loader = this.context.promptLoader ?? new PromptLoader({ baseDir: project.sessionDir });
    const promptBuilder = new PromptBuilder(loader);
    const resolved = promptBuilder.resolve(effectiveProfile.prompt);
    if (!resolved.fromConfig) {
      throw new StageError(
        `prompt file not loaded for profile "${profileId}". Ensure prompt.file points to an existing file.`,
        profile.role,
      );
    }

    const snapshot = await graphReader.readSnapshot({
      sessionId: project.sessionId,
      projectId: project.id,
      profileId,
      spec: profile.context,
      hints: input.hints,
      recentVerdicts: input.recentVerdicts,
      intent: input.intent,
      candidate: input.candidate,
      signal: input.signal,
    });
    const contextArtifact = await materializeGraphContext(
      project.sessionDir,
      logTimestamp,
      profileId,
      snapshot,
    );
    const contextBlock = renderGraphContextArtifact(snapshot, contextArtifact);
    const contextComponent = {
      source: `artifact:${contextArtifact.relativePath}`,
      resolvedPath: contextArtifact.resolvedPath,
      graphSeq: snapshot.graphSeq,
      artifactSha256: contextArtifact.sha256,
      delivery: contextArtifact.delivery,
    };
    const assignmentBody = input.promptExtra || [
      "## Assignment",
      `Execute the current ${profile.role} responsibility for project ${project.id}.`,
    ].join("\n");
    const assignment = profile.tools?.length
      ? `${assignmentBody}\n\nConfigured tools for this role: ${profile.tools.join(", ")}.`
      : assignmentBody;
    const outputContract = outputContractInstructions(effectiveProfile.output.contract);
    const built = promptBuilder.compose(resolved, contextBlock, assignment, contextComponent, outputContract);
    const result = await workerPool.execute({
      prompt: built.prompt,
      config: workerConfig,
      workerName,
      cwd: project.workspaceDir,
      signal: input.signal,
    });
    if (result.returncode !== 0) {
      const message = `${profile.role} worker failed: ${result.stderr ?? "no stderr"}`;
      await materializeRoleOutput(
        project.sessionDir,
        project.sessionId,
        project.id,
        logTimestamp,
        profileId,
        {
          status: "failed",
          error: message,
          returncode: result.returncode,
          stderr: result.stderr ?? "",
          rawText: result.text,
        },
      );
      throw new StageError(message, profile.role);
    }
    return this.validateAndPersist(
      logTimestamp,
      result.text,
      built.prompt,
      built.promptHash,
      built.manifest,
      effectiveProfile,
    );
  }

  private async validateAndPersist(
    logTimestamp: string,
    rawText: string,
    prompt: string,
    promptHash: string,
    promptManifest: PromptManifest,
    profile: SubagentProfile,
  ): Promise<BaseAgentResult> {
    try {
      const envelope = parseEnvelope(rawText, profile.role);
      const output = validateOutput(envelope, profile, this.context.profileId);
      await materializeRoleOutput(
        this.context.project.sessionDir,
        this.context.project.sessionId,
        this.context.project.id,
        logTimestamp,
        this.context.profileId,
        output,
      );
      return { output, rawText, prompt, promptHash, promptManifest };
    } catch (error) {
      await materializeRoleOutput(
        this.context.project.sessionDir,
        this.context.project.sessionId,
        this.context.project.id,
        logTimestamp,
        this.context.profileId,
        {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          rawText,
        },
      );
      throw error;
    }
  }
}

export function selectProfileWorker(
  profile: SubagentProfile,
  workerPool: WorkerPool,
  config: TaskConfig,
): WorkerName {
  const candidates = [...new Set(profile.runtime.workers?.length
    ? profile.runtime.workers
    : [profile.runtime.worker])].filter((name) => config.workers[name]);
  if (candidates.length === 0) throw new StageError(`no configured worker is available for ${profile.role}`, profile.role);
  const selected = workerPool.pickWorker(config, candidates);
  return candidates.includes(selected) ? selected : candidates[0]!;
}

const CONTRACT_KIND_MAP: Record<string, Set<string>> = {
  main_decision: new Set(["decisions"]),
  candidate_fact: new Set(["fact"]),
  verdict: new Set(["verdict"]),
  broadcast_assessment: new Set(["broadcast_assessment"]),
  hints: new Set(["hints", "stop"]),
  stop: new Set(["stop"]),
};

function validateOutput(envelope: WorkerEnvelope, profile: SubagentProfile, profileId: string): AgentOutput {
  const allowed = CONTRACT_KIND_MAP[profile.output.contract];
  if (allowed && !allowed.has(envelope.kind)) {
    throw new StageError(
      `profile "${profileId}" (contract="${profile.output.contract}") returned kind="${envelope.kind}", expected one of: ${[...allowed].join(", ")}`,
      profile.role,
    );
  }
  switch (envelope.kind) {
    case "decisions": return { kind: "decisions", decision: validateMainDecision(envelope) };
    case "fact": return { kind: "fact", fact: validateCandidateFact(envelope, profile.role) };
    case "verdict": return { kind: "verdict", verdict: validateVerdict(envelope, profile.role) };
    case "broadcast_assessment": return { kind: "broadcast_assessment", assessment: validateBroadcastAssessment(envelope, profile.role) };
    case "hints": return { kind: "hints", hints: validateHints(envelope, profile.role, profile.role) };
    case "stop": return { kind: "stop", stop: validateStop(envelope, profile.role) };
    default: throw new StageError(`unexpected envelope kind "${envelope.kind}" for profile "${profileId}"`, profile.role);
  }
}
