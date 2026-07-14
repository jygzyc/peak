/**
 * MainAgent — session-local planner wrapper.
 *
 * Delegates prompt assembly, worker execution, and output validation to
 * SubagentRunner. Returns a typed MainDecision + PermissionChecker that
 * SessionLoop feeds into DecisionApplier.
 *
 * The planner has no "phases" — it always receives the same prompt shape
 * (role preamble + current graph state + optional hints/verdicts) and decides
 * what to do next.
 */

import type { Hint, ProjectId, TaskConfig, Verdict } from "./types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { StageError } from "./parse-envelope.js";
import type { MainDecision } from "./contracts.js";
import { runSubagent, plannerExtra } from "./subagent-runner.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { PermissionChecker } from "./permissions.js";
import type { ContextLedger } from "./context-ledger.js";
import type { WorkerSessionManager } from "../worker/session-manager.js";

export interface MainAgentRunInput {
  hints?: Hint[];
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
}

export interface MainAgentContext {
  projectId: ProjectId;
  graph: Graph;
  config: TaskConfig;
  workerPool: WorkerPool;
  promptLoader?: PromptLoader;
  contextLedger?: ContextLedger;
  sessionManager?: WorkerSessionManager;
}

export interface MainAgentResult {
  decision: MainDecision;
  permissions: PermissionChecker;
}

export class MainAgent {
  constructor(private readonly ctx: MainAgentContext) {}

  async run(input: MainAgentRunInput): Promise<MainAgentResult> {
    const { config } = this.ctx;
    const mainProfileId = config.control?.mainProfile ?? "planner";
    const profile = config.profiles[mainProfileId];
    if (!profile) {
      throw new StageError(`main profile not found: ${mainProfileId}`, "planner");
    }

    const output = await runSubagent({
      profile,
      profileId: mainProfileId,
      projectId: this.ctx.projectId,
      graph: this.ctx.graph,
      workerPool: this.ctx.workerPool,
      config,
      promptExtra: plannerExtra(input.hints, input.recentVerdicts),
      hints: input.hints,
      recentVerdicts: input.recentVerdicts,
      promptLoader: this.ctx.promptLoader,
      contextLedger: this.ctx.contextLedger,
      sessionManager: this.ctx.sessionManager,
    });

    if (output.kind !== "decisions") {
      throw new StageError(
        `planner returned kind="${output.kind}", expected "decisions"`,
        "planner",
      );
    }

    // Honor the planner's explicit hint-consumption selection. Only when the
    // planner did NOT declare consumeHints (empty) do we fall back to consuming
    // all actionable hints — preserving the previous "act on every hint"
    // behavior so stop-explorer hints are still consumed by default. The prompt
    // tells the planner it may ignore hints, and that choice is now respected.
    if (output.decision.consumeHintIds.length === 0 && input.hints && input.hints.length > 0) {
      const actionable = input.hints.filter((h) => h.kind === "stop-explorer" || h.kind === "direction");
      if (actionable.length > 0) {
        output.decision.consumeHintIds = actionable.map((h) => h.id);
      }
    }

    return { decision: output.decision, permissions: new PermissionChecker(profile) };
  }
}
