/** Pure planner-role adapter. Database/run lifecycle belongs to SessionLoop. */

import type { Hint, Project, TaskConfig, Verdict, WorkerName } from "./types.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { StageError } from "./parse-envelope.js";
import type { MainDecision } from "./contracts.js";
import { runSubagent, type SubagentRunUpdate } from "./subagent-runner.js";
import { plannerExtra } from "./prompt-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { PermissionChecker } from "./permissions.js";
import type { SessionGraphReader } from "./context-builder.js";

export interface MainAgentRunInput {
  runId: string;
  workerName: WorkerName;
  hints?: Hint[];
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  signal?: AbortSignal;
  onRunUpdate?: (patch: SubagentRunUpdate) => void;
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
  runId: string;
}

export class MainAgent {
  constructor(private readonly ctx: MainAgentContext) {}

  async run(input: MainAgentRunInput): Promise<MainAgentResult> {
    const mainProfileId = this.ctx.config.control?.mainProfile ?? "planner";
    const profile = this.ctx.config.profiles[mainProfileId];
    if (!profile) throw new StageError(`main profile not found: ${mainProfileId}`, "planner");
    if (profile.role !== "planner") {
      throw new StageError(`main profile "${mainProfileId}" must bind role planner`, "planner");
    }

    const output = await runSubagent({
      profile,
      profileId: mainProfileId,
      project: this.ctx.project,
      workerPool: this.ctx.workerPool,
      config: this.ctx.config,
      promptExtra: plannerExtra(input.hints, input.recentVerdicts),
      hints: input.hints,
      recentVerdicts: input.recentVerdicts,
      promptLoader: this.ctx.promptLoader,
      graphReader: this.ctx.graphReader,
      runId: input.runId,
      workerNameOverride: input.workerName,
      signal: input.signal,
      onRunUpdate: input.onRunUpdate,
    });
    if (output.kind !== "decisions") {
      throw new StageError(`planner returned kind="${output.kind}", expected "decisions"`, "planner");
    }
    return {
      decision: output.decision,
      permissions: new PermissionChecker(profile),
      runId: input.runId,
    };
  }
}
