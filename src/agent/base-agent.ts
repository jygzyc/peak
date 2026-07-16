import type {
  AgentId,
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
  validateStop,
  validateVerdict,
  type CandidateFact,
  type MainDecision,
} from "./contracts.js";
import {
  estimateContextTokens,
  materializeGraphContext,
  materializeRoleOutput,
  renderGraphContextArtifact,
  type SessionGraphReader,
} from "./context-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { PromptBuilder } from "./prompt-builder.js";
import { AgentRecordStore, type AgentRecordPatch } from "./agent-record-store.js";

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
  agentId: AgentId;
  output: AgentOutput;
  rawText: string;
  prompt: string;
  usedConclude?: boolean;
  promptHash: string;
  promptManifest: PromptManifest;
}

/** Shared execution boundary for planner, explorer, evaluator and metacog. */
export class BaseAgent {
  protected readonly records: AgentRecordStore;

  constructor(protected readonly context: BaseAgentContext) {
    this.records = new AgentRecordStore(context.project.sessionDir);
  }

  protected async executeAgent(input: BaseAgentRunInput): Promise<BaseAgentResult> {
    const { profile, profileId, project, workerPool, config } = this.context;
    const workerName = input.workerName ?? selectProfileWorker(profile, project.id, workerPool, config);
    const workerConfig = config.workers[workerName];
    if (!workerConfig) throw new StageError(`worker config missing for ${profile.role}: ${workerName}`, profile.role);
    if (workerConfig.kind === "api") {
      throw new StageError(`role worker "${workerName}" cannot read session JSON artifacts; use an agent worker`, profile.role);
    }

    const record = await this.records.create({
      sessionId: project.session,
      projectId: project.id,
      profileId,
      role: profile.role,
      workerName,
      intentId: input.intent?.id,
      factId: input.candidate?.id,
      inputSummary: input.inputSummary,
    });

    try {
      return await this.execute(record.id, workerName, input);
    } catch (error) {
      await this.records.update(record.id, {
        status: input.signal?.aborted ? "cancelled" : "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  updateRecord(agentId: AgentId, patch: AgentRecordPatch): Promise<import("./types.js").AgentRecord> {
    return this.records.update(agentId, patch);
  }

  private async execute(
    agentId: AgentId,
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
      sessionId: project.session,
      projectId: project.id,
      profileId,
      spec: profile.context,
      hints: input.hints,
      recentVerdicts: input.recentVerdicts,
      intent: input.intent,
      candidate: input.candidate,
      signal: input.signal,
    });
    const contextArtifact = await materializeGraphContext(project.sessionDir, agentId, snapshot);
    const contextBlock = renderGraphContextArtifact(snapshot, contextArtifact);
    const contextComponent = {
      source: `artifact:${contextArtifact.relativePath}`,
      resolvedPath: contextArtifact.resolvedPath,
      graphSeq: snapshot.graphSeq,
      artifactSha256: contextArtifact.sha256,
      delivery: contextArtifact.delivery,
    };
    const assignment = input.promptExtra || [
      "## Assignment",
      `Execute the current ${profile.role} responsibility for project ${project.id}.`,
    ].join("\n");
    const outputContract = [
      "## Output Contract Binding",
      `Contract: ${effectiveProfile.output.contract}`,
      "Return one response that conforms to the contract declared by the role system prompt.",
    ].join("\n");
    const built = promptBuilder.compose(resolved, contextBlock, assignment, contextComponent, outputContract);
    await this.records.update(agentId, {
      promptHash: built.promptHash,
      promptManifest: built.manifest,
      contextArtifact,
      inputTokens: estimateContextTokens(built.prompt),
    });

    const result = await workerPool.execute({
      prompt: built.prompt,
      config: workerConfig,
      workerName,
      role: profile.role,
      projectId: project.id,
      cwd: project.workspaceDir,
      maxOutputTokens: profile.maxOutputTokens,
      signal: input.signal,
    });
    if (result.returncode !== 0) {
      throw new StageError(`${profile.role} worker failed: ${result.stderr ?? "no stderr"}`, profile.role);
    }
    if (result.sessionId) await this.records.update(agentId, { workerSessionId: result.sessionId });

    try {
      return await this.validateAndPersist(agentId, result.text, built.prompt, built.promptHash, built.manifest, effectiveProfile);
    } catch (parseError) {
      if (input.signal?.aborted || !profile.prompt.concludeFile) throw parseError;
      const concludeBuilt = promptBuilder.build({
        spec: { file: profile.prompt.concludeFile },
        primaryKind: "conclude",
        context: contextBlock,
        extra: [assignment, `## Prior Worker Output (failed to parse)\n${result.text.slice(0, 4000)}`].join("\n\n"),
        contextComponent,
        outputContract,
      });
      if (!concludeBuilt.fromConfig) throw parseError;
      const concludeResult = await workerPool.execute({
        prompt: concludeBuilt.prompt,
        config: workerConfig,
        workerName,
        role: profile.role,
        projectId: project.id,
        cwd: project.workspaceDir,
        maxOutputTokens: profile.maxOutputTokens,
        sessionId: result.sessionId,
        conclude: true,
        signal: input.signal,
      });
      if (concludeResult.returncode !== 0) throw parseError;
      if (concludeResult.sessionId ?? result.sessionId) {
        await this.records.update(agentId, { workerSessionId: concludeResult.sessionId ?? result.sessionId });
      }
      const validated = await this.validateAndPersist(
        agentId,
        concludeResult.text,
        concludeBuilt.prompt,
        concludeBuilt.promptHash,
        concludeBuilt.manifest,
        effectiveProfile,
      );
      await this.records.update(agentId, { usedConclude: true });
      return { ...validated, usedConclude: true };
    }
  }

  private async validateAndPersist(
    agentId: AgentId,
    rawText: string,
    prompt: string,
    promptHash: string,
    promptManifest: PromptManifest,
    profile: SubagentProfile,
  ): Promise<BaseAgentResult> {
    const envelope = parseEnvelope(rawText, profile.role);
    const output = validateOutput(envelope, profile, this.context.profileId);
    const outputArtifact = await materializeRoleOutput(
      this.context.project.sessionDir,
      this.context.project.session,
      this.context.project.id,
      agentId,
      profile.role,
      output,
    );
    await this.records.update(agentId, {
      status: "validated",
      promptHash,
      promptManifest,
      outputArtifact,
      outputTokens: estimateContextTokens(rawText),
    });
    return { agentId, output, rawText, prompt, promptHash, promptManifest };
  }
}

export function selectProfileWorker(
  profile: SubagentProfile,
  projectId: string,
  workerPool: WorkerPool,
  config: TaskConfig,
): WorkerName {
  const candidates = [...new Set(profile.runtime.workers?.length
    ? profile.runtime.workers
    : [profile.runtime.worker])].filter((name) => config.workers[name]);
  if (candidates.length === 0) throw new StageError(`no configured worker is available for ${profile.role}`, profile.role);
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
