/**
 * Wall-clock metacognition loop.
 *
 * Runs the metacog profile via SubagentRunner, independently of the main
 * SessionLoop step cadence. Tracks active SubagentRuns and honors maxActive
 * to prevent over-spawning.
 */

import type { Fact, ProjectId, TaskConfig } from "../agent/types.js";
import { DEFAULT_METACOG_TRIGGERS } from "../agent/types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { runSubagent, selectProfileWorker } from "../agent/subagent-runner.js";
import { metacogExtra } from "../agent/prompt-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { PermissionChecker } from "../agent/permissions.js";
import type { FederationOutboxInput } from "../graph/graph.js";
import { randomUUID } from "node:crypto";
import { DEFAULT_SCHEDULER } from "../agent/types.js";
import type { GlobalResourceGovernor } from "../worker/resource-governor.js";
import type { SessionGraphReader } from "../agent/context-builder.js";
import { ServerSessionGraphReader } from "../server/session-graph-reader.js";

const DEFAULT_METACOG_INTERVAL_MS = DEFAULT_METACOG_TRIGGERS.everySeconds
  ? DEFAULT_METACOG_TRIGGERS.everySeconds * 1000
  : 30_000;

export class MetacogSupervisor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private closed = false;
  private tickInFlight = false;
  private readonly intervalMs: number;
  private readonly promptLoader: PromptLoader;
  private readonly activeControllers = new Map<ProjectId, {
    controller: AbortController;
    heartbeatTimer: ReturnType<typeof setInterval>;
  }>();
  private readonly inFlightProjects = new Map<ProjectId, Promise<boolean>>();
  private readonly coordinatorId = `metacog:${process.pid}:${randomUUID()}`;
  private resourceGovernor?: GlobalResourceGovernor;
  private federation?: { sessionId: string; scope: string };

  constructor(
    private readonly graph: Graph,
    private workerPool: WorkerPool,
    private readonly config: TaskConfig,
    intervalMs?: number,
    federation?: { sessionId: string; scope?: string },
    graphReader?: SessionGraphReader,
  ) {
    this.graphReader = graphReader ?? new ServerSessionGraphReader(graph);
    if (federation) {
      this.setFederation(
        federation.sessionId,
        federation.scope ?? config.federation?.scope ?? federation.sessionId,
      );
    }
    // Read the wall-clock interval from the metacog profile's triggers (per-
    // agent), not a global workflow block. Fall back to the constructor arg,
    // then the module default.
    const metacogProfileId = config.control?.metacogProfile ?? "metacog";
    const metacogProfile = config.profiles[metacogProfileId] ?? config.profiles.metacog;
    const everySeconds = metacogProfile?.triggers?.everySeconds;
    this.intervalMs = intervalMs ?? (everySeconds ? everySeconds * 1000 : DEFAULT_METACOG_INTERVAL_MS);
    this.promptLoader = new PromptLoader();
  }

  setFederation(sessionId: string, scope = "default"): void {
    if (this.closed) throw new Error("MetacogSupervisor is closed");
    this.federation = { sessionId, scope };
  }

  unsetFederation(sessionId: string): void {
    if (this.federation?.sessionId === sessionId) this.federation = undefined;
  }

  setResourceGovernor(governor: GlobalResourceGovernor): void {
    if (this.closed) throw new Error("MetacogSupervisor is closed");
    if (this.resourceGovernor === governor) return;
    if (this.resourceGovernor) throw new Error("metacog resource governor is already bound");
    this.resourceGovernor = governor;
    this.workerPool = governor.wrap(this.workerPool);
  }

  start(): void {
    if (this.closed) throw new Error("MetacogSupervisor is closed");
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
    for (const active of this.activeControllers.values()) {
      active.controller.abort(new Error("metacog supervisor stopped"));
      clearInterval(active.heartbeatTimer);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    await Promise.allSettled([...this.inFlightProjects.values()]);
  }

  get isRunning(): boolean {
    return this.running;
  }

  interrupt(projectId: ProjectId): void {
    this.activeControllers.get(projectId)?.controller.abort(new Error("metacog cancelled by directive"));
  }

  async runOnce(): Promise<void> {
    const active = this.graph.listProjects("active");
    await Promise.allSettled(active.map((p) => this.runForProject(p.id)));
  }

  private async tick(): Promise<void> {
    if (!this.running || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const active = this.graph.listProjects("active");
      await Promise.allSettled(active.map((p) => this.runForProject(p.id, true)));
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Run metacog once per project. Concurrent timer/SessionLoop calls share the
   * same promise; persistent dispatchKey + Run claim provide cross-process
   * exclusion, so no project mutex is held while the worker performs I/O. */
  async runForProject(projectId: ProjectId, scheduled = false): Promise<boolean> {
    if (this.closed) throw new Error("MetacogSupervisor is closed");
    const existing = this.inFlightProjects.get(projectId);
    if (existing) return existing;
    const current = Promise.resolve().then(() => {
      if (scheduled && !this.running) return Promise.resolve(false);
      return this.executeForProject(projectId);
    }).finally(() => {
      if (this.inFlightProjects.get(projectId) === current) {
        this.inFlightProjects.delete(projectId);
      }
    });
    this.inFlightProjects.set(projectId, current);
    return current;
  }

  private async executeForProject(projectId: ProjectId): Promise<boolean> {
    this.graph.sweepExpiredLeases();
    const project = this.graph.getProject(projectId);
    if (!project || (project.status !== "active" && project.status !== "finish_proposed")) return false;
    const progress = this.graph.progress(projectId);
    const metacogProfileId = this.config.control?.metacogProfile ?? "metacog";
    const profile = this.config.profiles[metacogProfileId] ?? this.config.profiles.metacog;
    if (!profile) return false;
    if (profile.role !== "metacog") {
      throw new Error(`metacog profile "${metacogProfileId}" must bind role metacog`);
    }

    const completedRuns = this.graph.subagentRuns(projectId, { profileId: metacogProfileId, status: "completed" });
    const reviewedFactIds = new Set(completedRuns.map((run) => run.factId).filter(Boolean));
    const factToReview = this.graph.facts(projectId, "pass")
      .find((fact) => !reviewedFactIds.has(fact.id));
    const finalReview = project.status === "finish_proposed";

    // Per-profile periodic triggers remain useful for course correction, but
    // accepted facts and final review are protocol triggers and cannot be
    // coalesced away by a timer or an in-memory checkpoint.
    const triggers = profile.triggers ?? DEFAULT_METACOG_TRIGGERS;
    const stagnationTrigger = triggers.stagnationLevel ?? DEFAULT_METACOG_TRIGGERS.stagnationLevel ?? 3;
    const everySteps = triggers.everySteps ?? DEFAULT_METACOG_TRIGGERS.everySteps ?? 5;

    const shouldRun = Boolean(factToReview) || finalReview
      || progress.stagnationLevel >= stagnationTrigger
      || progress.stepsExecuted > 0 && progress.stepsExecuted % everySteps === 0;

    if (!shouldRun) return false;

    const trigger = factToReview ? `fact.accepted:${factToReview.id}`
      : finalReview ? "final-review"
        : `scheduled:${progress.stepsExecuted}:${progress.stagnationLevel}`;
    if (!factToReview && !finalReview && completedRuns.some((run) => run.inputSummary === trigger)) return false;

    const maxActive = profile.maxActive ?? 1;
    const activeRuns = this.graph.subagentRuns(projectId, { profileId: metacogProfileId, status: "running" });
    if (activeRuns.length >= maxActive) return false;

    const run = this.graph.createSubagentRun(projectId, {
      profileId: metacogProfileId,
      role: profile.role,
      workerName: selectProfileWorker(profile, projectId, this.workerPool, this.config),
      factId: factToReview?.id,
      inputSummary: trigger,
      dispatchKey: `metacog:${trigger}`,
    });
    const leaseMs = this.config.scheduler?.workerLeaseMs ?? DEFAULT_SCHEDULER.workerLeaseMs;
    const runClaim = this.graph.claimSubagentRun(
      projectId,
      run.id,
      this.coordinatorId,
      leaseMs,
    );
    if (!runClaim) return false;
    const controller = new AbortController();
    const heartbeatTimer = setInterval(() => {
      try {
        this.graph.heartbeatSubagentRun(projectId, run.id, runClaim, leaseMs);
      } catch (error) {
        controller.abort(error instanceof Error
          ? error
          : new Error(`metacog lease lost: ${String(error)}`));
      }
    }, Math.max(5, Math.floor(leaseMs / 3)));
    heartbeatTimer.unref?.();
    this.activeControllers.set(projectId, { controller, heartbeatTimer });

    try {
      const permissions = new PermissionChecker(profile);
      permissions.require("get_graph");
      const output = await runSubagent({
        profile,
        profileId: metacogProfileId,
        project,
        workerPool: this.workerPool, config: this.config,
        promptLoader: this.promptLoader,
        graphReader: this.graphReader,
        runId: run.id,
        onRunUpdate: (patch) => this.graph.updateSubagentRun(projectId, run.id, patch, runClaim),
        workerNameOverride: run.workerName,
        signal: controller.signal,
        promptExtra: metacogExtra(trigger),
      });

      if (output.kind === "hints") {
        permissions.require("create_hint");
        const finalReviewCompleted = finalReview && !factToReview
          && output.hints.hints.length === 0
          && this.graph.getProject(projectId)?.status === "finish_proposed";
        const broadcast = this.buildOutboxItem(
          projectId,
          factToReview,
          finalReviewCompleted,
        );
        if (broadcast) permissions.require("send_fact_broadcast");
        this.graph.commitMetacogResult(projectId, run.id, {
          hints: output.hints.hints,
          outputSummary: `${output.hints.hints.length} hints`,
          reviewedFactId: factToReview?.id,
          broadcast,
          finalReviewCompleted,
        }, runClaim);
        return output.hints.hints.length > 0;
      } else if (output.kind === "stop") {
        permissions.require("create_hint");
        const hint = {
          creator: profile.role,
          kind: "warning" as const,
          content: `Metacog recommends ending or redirecting the task: ${output.stop.reason}`,
        };
        const broadcast = this.buildOutboxItem(projectId, factToReview, false);
        if (broadcast) permissions.require("send_fact_broadcast");
        this.graph.commitMetacogResult(projectId, run.id, {
          hints: [hint],
          outputSummary: `end recommendation: ${output.stop.reason}`,
          reviewedFactId: factToReview?.id,
          broadcast,
        }, runClaim);
        this.graph.logEvent(projectId, "metacog.end_recommendation", { reason: output.stop.reason });
        return true;
      } else {
        this.graph.updateSubagentRun(projectId, run.id, {
          status: "completed",
          outputSummary: `unexpected kind: ${output.kind}`,
        }, runClaim);
        return false;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        this.graph.updateSubagentRun(projectId, run.id, {
          status: controller.signal.aborted ? "cancelled" : "failed",
          errorMessage: reason,
        }, runClaim);
        this.graph.logEvent(projectId, controller.signal.aborted ? "metacog.cancelled" : "metacog.error", {
          error: reason,
        });
      } catch { /* expired/reassigned attempt is fenced */ }
      return false;
    } finally {
      const active = this.activeControllers.get(projectId);
      if (active?.controller === controller) {
        clearInterval(active.heartbeatTimer);
        this.activeControllers.delete(projectId);
      }
    }
  }

  private buildOutboxItem(
    projectId: ProjectId,
    fact: Fact | undefined,
    finalReviewCompleted: boolean,
  ): FederationOutboxInput | undefined {
    if (!this.federation) return undefined;
    if (fact) {
      return {
        eventId: `fact:${this.federation.sessionId}:${projectId}:${fact.id}`,
        scope: this.federation.scope,
        kind: "fact",
        sourceFactId: fact.id,
        summary: fact.description,
        confidence: fact.confidence,
      };
    }
    if (!finalReviewCompleted) return undefined;
    const endFact = this.graph.activeEndFact(projectId);
    if (!endFact) return undefined;
    return {
      eventId: `summary:${this.federation.sessionId}:${projectId}:${endFact.id}`,
      scope: this.federation.scope,
      kind: "session_summary",
      summary: endFact.description,
      confidence: 1,
    };
  }

  private readonly graphReader: SessionGraphReader;
}
