/**
 * Wall-clock metacognition loop.
 *
 * Runs the metacog profile via SubagentRunner, independently of the main
 * SessionLoop step cadence. Tracks active SubagentRuns and honors maxActive
 * to prevent over-spawning.
 */

import type { ProjectId, TaskConfig } from "../agent/types.js";
import { DEFAULT_METACOG_TRIGGERS } from "../agent/types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { runSubagent, metacogExtra } from "../agent/subagent-runner.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { ContextLedger } from "../agent/context-ledger.js";
import { WorkerSessionManager } from "../worker/session-manager.js";
import { ProjectLockManager } from "./project-lock.js";

const DEFAULT_METACOG_INTERVAL_MS = DEFAULT_METACOG_TRIGGERS.everySeconds
  ? DEFAULT_METACOG_TRIGGERS.everySeconds * 1000
  : 30_000;

export class MetacogSupervisor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly intervalMs: number;
  private readonly promptLoader: PromptLoader;
  readonly contextLedger = new ContextLedger();
  readonly sessionManager = new WorkerSessionManager();

  constructor(
    private readonly graph: Graph,
    private readonly workerPool: WorkerPool,
    private readonly config: TaskConfig,
    private readonly locks: ProjectLockManager,
    intervalMs?: number,
  ) {
    // Read the wall-clock interval from the metacog profile's triggers (per-
    // agent), not a global workflow block. Fall back to the constructor arg,
    // then the module default.
    const metacogProfileId = config.control?.metacogProfile ?? "metacog";
    const metacogProfile = config.profiles[metacogProfileId] ?? config.profiles.metacog;
    const everySeconds = metacogProfile?.triggers?.everySeconds;
    this.intervalMs = intervalMs ?? (everySeconds ? everySeconds * 1000 : DEFAULT_METACOG_INTERVAL_MS);
    this.promptLoader = new PromptLoader();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  async runOnce(): Promise<void> {
    const active = this.graph.listProjects("active");
    await Promise.allSettled(active.map((p) => this.runForProject(p.id)));
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const active = this.graph.listProjects("active");
    await Promise.allSettled(active.map((p) => this.runForProject(p.id)));
  }

  /** Run metacog for a project, acquiring the project lock. Used by the timer
   * and runOnce. Returns true if the metacog produced hints or a stop. */
  async runForProject(projectId: ProjectId): Promise<boolean> {
    return this.locks.acquire(projectId, () => this.runForProjectLocked(projectId));
  }

  /**
   * Run metacog for a project WITHOUT acquiring the project lock. Called from
   * SessionLoop.stepLocked, which already holds the lock (ProjectLockManager is
   * non-reentrant, so the caller must NOT re-acquire). Returns true if the
   * metacog produced hints or a stop request — the loop uses this to decide
   * whether to give the planner another step to act on the hint.
   */
  async runForProjectLocked(projectId: ProjectId): Promise<boolean> {
    const progress = this.graph.progress(projectId);
    const metacogProfileId = this.config.control?.metacogProfile ?? "metacog";
    const profile = this.config.profiles[metacogProfileId] ?? this.config.profiles.metacog;
    if (!profile) return false;

    // Per-profile triggers (no global workflow block). Stagnation is NOT a
    // hard stop — it only fires the metacog loop, whose hints the planner
    // then acts on. The planner remains the sole termination judge.
    const triggers = profile.triggers ?? DEFAULT_METACOG_TRIGGERS;
    const stagnationTrigger = triggers.stagnationLevel ?? DEFAULT_METACOG_TRIGGERS.stagnationLevel ?? 3;
    const everySteps = triggers.everySteps ?? DEFAULT_METACOG_TRIGGERS.everySteps ?? 5;

    const shouldRun =
      progress.stagnationLevel >= stagnationTrigger
      || progress.stepsExecuted > 0 && progress.stepsExecuted % everySteps === 0
      || progress.openIntents === 0 && progress.pendingFacts === 0 && progress.passFacts > 0;

    if (!shouldRun) return false;

    const maxActive = profile.maxActive ?? 1;
    const activeRuns = this.graph.subagentRuns(projectId, { profileId: metacogProfileId, status: "running" });
    if (activeRuns.length >= maxActive) return false;

    const run = this.graph.createSubagentRun(projectId, {
      profileId: metacogProfileId,
      role: profile.role,
      workerName: profile.runtime.worker,
      inputSummary: "scheduled metacog tick",
    });

    try {
      this.graph.updateSubagentRun(projectId, run.id, { status: "running" });

      const output = await runSubagent({
        profile,
        profileId: metacogProfileId,
        projectId, graph: this.graph,
        workerPool: this.workerPool, config: this.config,
        promptLoader: this.promptLoader,
        contextLedger: this.contextLedger,
        sessionManager: this.sessionManager,
        promptExtra: metacogExtra("scheduled"),
      });

      if (output.kind === "hints") {
        for (const hint of output.hints.hints) {
          this.graph.addHint(projectId, hint);
        }
        this.graph.updateSubagentRun(projectId, run.id, {
          status: "completed",
          outputSummary: `${output.hints.hints.length} hints`,
        });
        return output.hints.hints.length > 0;
      } else if (output.kind === "stop") {
        this.graph.updateProjectStatus(projectId, "stopped");
        this.graph.logEvent(projectId, "metacog.stop_request", { reason: output.stop.reason });
        this.graph.updateSubagentRun(projectId, run.id, {
          status: "completed",
          outputSummary: `stop: ${output.stop.reason}`,
        });
        return true;
      } else {
        this.graph.updateSubagentRun(projectId, run.id, {
          status: "completed",
          outputSummary: `unexpected kind: ${output.kind}`,
        });
        return false;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.graph.updateSubagentRun(projectId, run.id, { status: "failed", errorMessage: reason });
      this.graph.logEvent(projectId, "metacog.error", { error: reason });
      return false;
    }
  }
}
