import type { Hint, Project, TaskConfig, Verdict, WorkerName } from "./types.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { StageError } from "./parse-envelope.js";
import type { MainDecision } from "./contracts.js";
import { BaseAgent } from "./base-agent.js";
import { plannerExtra } from "./prompt-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { PermissionChecker } from "./permissions.js";
import type { SessionGraphReader } from "./context-builder.js";

export interface MainAgentRunInput {
  workerName?: WorkerName;
  hints?: Hint[];
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  signal?: AbortSignal;
}

export interface MainAgentContext {
  project: Project;
  config: TaskConfig;
  workerPool: WorkerPool;
  graphReader: SessionGraphReader;
  promptLoader?: PromptLoader;
}

export interface MainAgentResult {
  decision: MainDecision;
  permissions: PermissionChecker;
  agentId: string;
}

export class MainAgent extends BaseAgent {
  private readonly profileId: string;

  constructor(private readonly mainContext: MainAgentContext) {
    const profileId = mainContext.config.control?.mainProfile ?? "planner";
    const profile = mainContext.config.profiles[profileId];
    if (!profile) throw new StageError(`main profile not found: ${profileId}`, "planner");
    if (profile.role !== "planner") {
      throw new StageError(`main profile "${profileId}" must bind role planner`, "planner");
    }
    super({ ...mainContext, profile, profileId });
    this.profileId = profileId;
  }

  async run(input: MainAgentRunInput): Promise<MainAgentResult> {
    const result = await this.executeAgent({
      promptExtra: plannerExtra(input.hints, input.recentVerdicts),
      inputSummary: "planner graph decision",
      hints: input.hints,
      recentVerdicts: input.recentVerdicts,
      workerName: input.workerName,
      signal: input.signal,
    });
    if (result.output.kind !== "decisions") {
      throw new StageError(`planner returned kind="${result.output.kind}", expected "decisions"`, "planner");
    }
    return {
      decision: result.output.decision,
      permissions: new PermissionChecker(this.mainContext.config.profiles[this.profileId]!),
      agentId: result.agentId,
    };
  }
}
