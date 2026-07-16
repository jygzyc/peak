/**
 * Per-session main loop.
 *
 * Drives project steps: directives → planner (MainAgent) → explorers
 * (SubagentRunner) → evaluators (SubagentRunner) → termination. Scheduling and
 * SubagentRun lifecycle live here; role-specific prompt formatting is delegated
 * to PromptBuilder and execution to SubagentRunner.
 */

import type {
  Directive, DirectiveInput, Intent, ProjectId, IntentId, ProjectStatus,
  SessionRole, SubagentProfile, TaskConfig,
} from "../agent/types.js";
import { DEFAULT_SCHEDULER } from "../agent/types.js";
import type { Graph } from "../graph/graph.js";
import type { IntentLeaseClaim, RunLeaseClaim } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { StageError } from "../agent/parse-envelope.js";
import { MainAgent } from "../agent/main-agent.js";
import { applyMainDecision } from "../agent/decision-applier.js";
import {
  runSubagent,
  runSubagentWithText,
  selectProfileWorker,
} from "../agent/subagent-runner.js";
import { explorerExtra, evaluatorExtra, broadcastEvaluatorExtra } from "../agent/prompt-builder.js";
import { estimateContextTokens } from "../agent/context-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import type { FederationBus } from "../graph/federation-bus.js";
import type { MetacogSupervisor } from "./metacog-supervisor.js";
import { PermissionChecker, PermissionDeniedError } from "../agent/permissions.js";
import { randomUUID } from "node:crypto";
import type { GlobalResourceGovernor } from "../worker/resource-governor.js";
import { SessionCoordinator } from "./session-coordinator.js";
import type { Permission } from "../agent/types.js";
import type { SessionGraphReader } from "../agent/context-builder.js";
import { ServerSessionGraphReader } from "../server/session-graph-reader.js";

/** Max times an explorer may fail the same intent before the loop auto-fails it.
 *  Without this cap a persistently-broken explorer (bad output, flaky backend)
 *  releases the intent back to "open" every step and is re-dispatched forever —
 *  no verdict is ever produced to wake the planner, so the loop deadlocks. */
const DEFAULT_MAX_ATTEMPTS = 3;

export type StepResult =
  | { type: "stepped"; intentsDispatched: number; factsAccepted: number }
  | { type: "idle"; reason: string }
  | { type: "completed" }
  | { type: "stopped"; reason: string }
  | { type: "failed"; reason: string };

export interface RunOptions {
  idlePollMs?: number;
  onStep?: (projectId: ProjectId, step: number, result: StepResult) => void;
}

export interface SessionLoopOptions {
  /** Cross-session insight bus. When set, accepted facts and dead-ends are
   * published so other sessions can learn from them (read-only). */
  federationBus?: FederationBus;
  /** This session's id, used as the source attribution on published insights. */
  sessionId?: string;
  /** Task-group broadcast visibility boundary. */
  federationScope?: string;
  /** Metacog supervisor driven synchronously inside each step (after
   * evaluators, before termination). When set, metacog reviews the graph and
   * emits correction hints the planner consumes on the next step. */
  metacog?: MetacogSupervisor;
  /** Stable only for this coordinator process; persisted Run epochs provide
   * correctness across restarts. Primarily injectable for deterministic tests. */
  coordinatorId?: string;
  graphReader?: SessionGraphReader;
}

export class SessionLoop {
  private readonly promptLoader: PromptLoader;
  private federationBus?: FederationBus;
  private sessionId?: string;
  private federationScope: string;
  private federationRegistration?: {
    bus: FederationBus;
    sessionId: string;
    scope: string;
    projectId?: ProjectId;
  };
  private metacog?: MetacogSupervisor;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly inFlightSteps = new Map<ProjectId, Promise<StepResult>>();
  private readonly activeExecutions = new Map<ProjectId, Map<string, {
    controller: AbortController;
    intentId?: IntentId;
    heartbeatTimer: ReturnType<typeof setInterval>;
  }>>();
  private readonly coordinatorId: string;
  private resourceGovernor?: GlobalResourceGovernor;
  private readonly coordinator: SessionCoordinator;
  private readonly graphReader: SessionGraphReader;

  constructor(
    private readonly graph: Graph,
    private workerPool: WorkerPool,
    private readonly config: TaskConfig,
    options: SessionLoopOptions = {},
  ) {
    const existingProjects = graph.listProjects();
    if (existingProjects.length > 1) {
      throw new Error(
        "SessionLoop requires exactly one task/Project per session; use GlobalSupervisor for multiple sessions",
      );
    }
    this.promptLoader = new PromptLoader();
    this.graphReader = options.graphReader ?? new ServerSessionGraphReader(graph);
    this.coordinator = new SessionCoordinator(graph);
    this.coordinatorId = options.coordinatorId ?? `session:${process.pid}:${randomUUID()}`;
    this.federationBus = options.federationBus;
    this.sessionId = options.sessionId;
    this.federationScope = options.federationScope
      ?? config.federation?.scope
      ?? options.sessionId
      ?? "default";
    this.metacog = options.metacog;
    if (this.federationBus && this.sessionId && existingProjects.length === 1) {
      this.registerFederationMembership(this.federationBus, this.sessionId, this.federationScope);
    }
    this.graph.sweepExpiredLeases();
  }

  requireProfilePermission(profileId: string, permission: Permission): void {
    const profile = this.config.profiles[profileId];
    if (!profile) throw new PermissionDeniedError(profileId, permission);
    new PermissionChecker(profile).require(permission);
  }

  setFederation(bus: FederationBus, sessionId: string, scope = this.federationScope): void {
    if (this.closed) throw new Error("SessionLoop is closed");
    const previous = this.federationRegistration;
    this.registerFederationMembership(bus, sessionId, scope);
    if (previous && (previous.bus !== bus || previous.sessionId !== sessionId)) {
      previous.bus.unregisterSession(previous.sessionId);
    }
    this.federationBus = bus;
    this.sessionId = sessionId;
    this.federationScope = scope;
    this.metacog?.setFederation(sessionId, scope);
  }

  unsetFederation(bus: FederationBus, sessionId: string): void {
    if (this.federationBus !== bus || this.sessionId !== sessionId) return;
    if (this.federationRegistration) bus.unregisterSession(sessionId);
    this.federationRegistration = undefined;
    this.federationBus = undefined;
    this.sessionId = undefined;
    this.metacog?.unsetFederation(sessionId);
  }

  setResourceGovernor(governor: GlobalResourceGovernor): void {
    if (this.closed) throw new Error("SessionLoop is closed");
    if (this.resourceGovernor === governor) return;
    if (this.resourceGovernor) throw new Error("session resource governor is already bound");
    this.resourceGovernor = governor;
    this.workerPool = governor.wrap(this.workerPool);
    this.metacog?.setResourceGovernor(governor);
  }

  private registerFederationMembership(bus: FederationBus, sessionId: string, scope: string): void {
    const members = this.config.federation?.members;
    const projects = this.graph.listProjects();
    const projectId = projects.length === 1 ? projects[0]!.id : undefined;
    const current = this.federationRegistration;
    if (current?.bus === bus && current.sessionId === sessionId
      && current.scope === scope && current.projectId === projectId) return;
    if (members && members.length > 0) bus.registerExpectedSessions(scope, members);
    bus.registerSession(sessionId, scope, projectId);
    this.federationRegistration = { bus, sessionId, scope, projectId };
  }

  projectIds(): ProjectId[] {
    return this.graph.listProjects().map((project) => project.id);
  }

  projectStatus(projectId: ProjectId): ProjectStatus | undefined {
    return this.graph.getProject(projectId)?.status;
  }

  taskGroupScope(): string {
    return this.federationScope;
  }

  private profileForRole(role: SessionRole): { profileId: string; profile: SubagentProfile } {
    const profileId = role === "planner"
      ? this.config.control?.mainProfile ?? "planner"
      : role === "explorer"
        ? this.config.control?.explorerProfile ?? "explorer"
        : role === "evaluator"
          ? this.config.control?.evaluatorProfile ?? "evaluator"
          : this.config.control?.metacogProfile ?? "metacog";
    const profile = this.config.profiles[profileId];
    if (!profile) throw new Error(`${role} profile not found: ${profileId}`);
    if (profile.role !== role) {
      throw new Error(`profile "${profileId}" binds role "${profile.role}", expected "${role}"`);
    }
    return { profileId, profile };
  }

  canCompleteFromSupervisor(projectId: ProjectId): boolean {
    const project = this.graph.getProject(projectId);
    if (!project || project.status !== "finish_proposed" || !this.graph.activeEndFact(projectId)) {
      return false;
    }
    const progress = this.graph.progress(projectId);
    if (progress.openIntents > 0 || progress.claimedIntents > 0 || progress.candidateFacts > 0) {
      return false;
    }
    if (this.coordinator.recentVerdicts(projectId).length > 0) return false;
    if (this.graph.federationOutbox(projectId, "pending").length > 0) return false;
    const hasActiveRuns = this.graph.subagentRuns(projectId).some(
      (run) => run.status === "pending" || run.status === "running",
    );
    if (hasActiveRuns) return false;

    if (this.metacog) {
      const events = this.graph.events(projectId);
      const proposalSeq = [...events].reverse()
        .find((event) => event.type === "planner.end_fact_created")?.seq ?? 0;
      const finalReviewSeq = [...events].reverse()
        .find((event) => event.type === "metacog.final_review_completed")?.seq ?? 0;
      if (finalReviewSeq <= proposalSeq) return false;
    }
    return true;
  }

  completeFromSupervisor(projectId: ProjectId): boolean {
    if (!this.canCompleteFromSupervisor(projectId)) return false;
    const progress = this.graph.progress(projectId);
    this.graph.updateProjectStatus(projectId, "completed");
    this.graph.logEvent(projectId, "project.completed_by_task_group", {
      scope: this.federationScope,
      stepsExecuted: progress.stepsExecuted,
      acceptedFacts: progress.passFacts,
    });
    return true;
  }

  /** Inject the session-local metacog supervisor after both components exist. */
  setMetacog(metacog: MetacogSupervisor): void {
    if (this.closed) throw new Error("SessionLoop is closed");
    if (this.metacog && this.metacog !== metacog) {
      throw new Error("session metacog supervisor is already bound");
    }
    this.metacog = metacog;
    if (this.sessionId) metacog.setFederation(this.sessionId, this.federationScope);
    if (this.resourceGovernor) metacog.setResourceGovernor(this.resourceGovernor);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const executions of this.activeExecutions.values()) {
      for (const execution of executions.values()) {
        execution.controller.abort(new Error("session loop closed"));
        clearInterval(execution.heartbeatTimer);
      }
    }
    this.closePromise = (async () => {
      const metacogClose = this.metacog?.close() ?? Promise.resolve();
      await Promise.all([
        Promise.allSettled([...this.inFlightSteps.values()]),
        metacogClose,
      ]);
      if (this.federationBus && this.sessionId) {
        this.unsetFederation(this.federationBus, this.sessionId);
      }
    })();
    return this.closePromise;
  }

  async step(projectId: ProjectId): Promise<StepResult> {
    if (this.closed) throw new Error("SessionLoop is closed");
    const existing = this.inFlightSteps.get(projectId);
    if (existing) return existing;
    const current = this.stepCycle(projectId).finally(() => {
      if (this.inFlightSteps.get(projectId) === current) {
        this.inFlightSteps.delete(projectId);
      }
    });
    this.inFlightSteps.set(projectId, current);
    return current;
  }

  /** Persist a directive and immediately signal matching in-flight workers.
   * Graph mutation remains the durable control-plane record; AbortController
   * makes stop/pause/kill responsive while a worker is doing external I/O. */
  addDirective(projectId: ProjectId, input: DirectiveInput): Directive {
    if (this.closed) throw new Error("SessionLoop is closed");
    const directive = this.graph.addDirective(projectId, input);
    if (input.kind === "stop") {
      this.graph.updateProjectStatus(projectId, "stopped");
      this.cancelPersistedExecutions(projectId, "session stopped by directive");
      this.abortExecutions(projectId);
      this.metacog?.interrupt(projectId);
    } else if (input.kind === "pause") {
      this.graph.updateProjectStatus(projectId, "paused");
      this.cancelPersistedExecutions(projectId, "session paused by directive");
      this.abortExecutions(projectId);
      this.metacog?.interrupt(projectId);
    } else if (input.kind === "resume") {
      this.graph.updateProjectStatus(projectId, "active");
    } else if (input.kind === "kill-intent") {
      this.cancelPersistedExecutions(projectId, "intent killed by directive", input.payload);
      this.abortExecutions(projectId, input.payload);
      try {
        this.graph.failIntent(projectId, input.payload, "killed by directive", false, "directive");
      } catch { /* intent may not exist or may already be terminal */ }
    }
    return directive;
  }

  async tick(): Promise<StepResult[]> {
    if (this.closed) throw new Error("SessionLoop is closed");
    this.graph.sweepExpiredLeases();
    const active = [
      ...this.graph.listProjects("active"),
      ...this.graph.listProjects("finish_proposed"),
    ];
    const results = await Promise.allSettled(active.map((p) => this.step(p.id)));
    return results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { type: "failed" as const, reason: `exception: ${(r.reason as Error)?.message ?? String(r.reason)}` },
    );
  }

  async run(projectId: ProjectId, options: RunOptions = {}): Promise<StepResult> {
    // Unbounded exploration/blackboard loop. Termination is natural: the planner
    // produces no new intent and none are in flight (see checkTermination), or an
    // external stop/pause directive flips the project status. There is NO depth
    // limit — metacog hints are the course-correction mechanism, not a hard stop.
    const idlePollMs = options.idlePollMs ?? 50;
    let lastResult: StepResult = { type: "stepped", intentsDispatched: 0, factsAccepted: 0 };

    for (let step = 1; ; step += 1) {
      lastResult = await this.step(projectId);
      options.onStep?.(projectId, step, lastResult);
      if (lastResult.type === "completed" || lastResult.type === "stopped" || lastResult.type === "failed") break;
      if (lastResult.type === "idle") await sleep(idlePollMs);
    }
    return lastResult;
  }

  private async stepCycle(projectId: ProjectId): Promise<StepResult> {
    const project = this.graph.getProject(projectId);
    if (!project) return { type: "failed", reason: "project not found" };

    this.graph.sweepExpiredLeases();

    await this.consumeDirectives(projectId);
    const current = this.graph.getProject(projectId)!;
    if (current.status !== "active" && current.status !== "finish_proposed") {
      if (current.status === "completed") return { type: "completed" };
      if (current.status === "stopped") return { type: "stopped", reason: "stopped by directive" };
      if (current.status === "failed") return { type: "failed", reason: "project failed" };
      return { type: "idle", reason: `project status=${current.status}` };
    }

    const factsBefore = this.graph.facts(projectId, "pass").length;

    this.flushFederationOutbox(projectId);
    await this.processFederationBroadcasts(projectId);
    await this.consumeDirectives(projectId);
    const afterBroadcastControl = this.controlResult(projectId);
    if (afterBroadcastControl) return afterBroadcastControl;
    const afterFederation = this.graph.getProject(projectId)!;

    const finishing = afterFederation.status === "finish_proposed";
    const plannerSucceeded = finishing ? true : await this.maybeRunPlanner(projectId);
    await this.consumeDirectives(projectId);
    const afterPlannerControl = this.controlResult(projectId);
    if (afterPlannerControl) return afterPlannerControl;
    const dispatched = finishing ? 0 : await this.dispatchExplorers(projectId);
    await this.consumeDirectives(projectId);
    const afterExplorerControl = this.controlResult(projectId);
    if (afterExplorerControl) return afterExplorerControl;
    await this.runEvaluators(projectId);
    await this.consumeDirectives(projectId);
    const afterEvaluatorControl = this.controlResult(projectId);
    if (afterEvaluatorControl) return afterEvaluatorControl;

    // Metacog uses an in-flight promise plus a persistent Run claim, without
    // holding a process-local mutex during worker I/O. It reviews the graph
    // after evaluator verdicts and before termination, so correction hints are
    // visible to the planner on the next step.
    if (this.metacog) {
      await this.metacog.runForProject(projectId);
    }
    await this.consumeDirectives(projectId);
    const afterMetacogControl = this.controlResult(projectId);
    if (afterMetacogControl) return afterMetacogControl;
    this.flushFederationOutbox(projectId);

    if (!plannerSucceeded) {
      const status = this.graph.getProject(projectId)?.status;
      if (status === "failed") return { type: "failed", reason: "planner retry limit exhausted" };
      if (status === "completed") return { type: "completed" };
      if (status === "stopped") return { type: "stopped", reason: "stopped by directive" };
      const factsAfter = this.graph.facts(projectId, "pass").length;
      return { type: "stepped", intentsDispatched: dispatched, factsAccepted: factsAfter - factsBefore };
    }

    const term = this.checkTermination(projectId);
    if (term) return term;

    const factsAfter = this.graph.facts(projectId, "pass").length;
    return { type: "stepped", intentsDispatched: dispatched, factsAccepted: factsAfter - factsBefore };
  }

  private async consumeDirectives(projectId: ProjectId): Promise<void> {
    const directives = this.graph.unconsumedDirectives(projectId);
    for (const dir of directives) {
      this.graph.consumeDirective(projectId, dir.id);
      switch (dir.kind) {
        case "stop":
          this.graph.updateProjectStatus(projectId, "stopped");
          this.cancelPersistedExecutions(projectId, "session stopped by directive");
          this.graph.logEvent(projectId, "directive.stop", { reason: dir.payload });
          return;
        case "pause":
          this.graph.updateProjectStatus(projectId, "paused");
          this.cancelPersistedExecutions(projectId, "session paused by directive");
          this.graph.logEvent(projectId, "directive.pause", { reason: dir.payload });
          return;
        case "resume":
          this.graph.updateProjectStatus(projectId, "active");
          this.graph.logEvent(projectId, "directive.resume", {});
          break;
        case "hint":
          this.graph.addHint(projectId, { content: dir.payload, creator: "human" });
          this.graph.logEvent(projectId, "directive.hint", { content: dir.payload });
          break;
        case "kill-intent":
          this.cancelPersistedExecutions(projectId, "intent killed by directive", dir.payload);
          try {
            this.graph.failIntent(projectId, dir.payload, "killed by directive", false, "directive");
            this.graph.logEvent(projectId, "directive.kill", { intentId: dir.payload });
          } catch { /* intent may not exist */ }
          break;
        case "spawn-intent":
          this.graph.addIntent(projectId, { description: dir.payload, creator: "human" });
          this.graph.logEvent(projectId, "directive.spawn", { description: dir.payload });
          break;
      }
    }
  }

  private controlResult(projectId: ProjectId): StepResult | undefined {
    const status = this.graph.getProject(projectId)?.status;
    if (status === "stopped") return { type: "stopped", reason: "stopped by directive" };
    if (status === "failed") return { type: "failed", reason: "project failed" };
    if (status === "paused") return { type: "idle", reason: "paused by directive" };
    if (status === "completed") return { type: "completed" };
    return undefined;
  }

  private startExecution(
    projectId: ProjectId,
    key: string,
    runClaim: RunLeaseClaim,
    intentId?: IntentId,
    intentClaim?: IntentLeaseClaim,
  ): AbortController {
    const controller = new AbortController();
    const leaseMs = this.config.scheduler?.workerLeaseMs ?? DEFAULT_SCHEDULER.workerLeaseMs;
    const heartbeatTimer = setInterval(() => {
      try {
        this.graph.heartbeatSubagentRun(projectId, key, runClaim, leaseMs);
        if (intentId && intentClaim) {
          this.graph.renewIntentLease(projectId, intentId, intentClaim, leaseMs);
        }
      } catch (error) {
        controller.abort(error instanceof Error
          ? error
          : new Error(`execution lease lost: ${String(error)}`));
      }
    }, Math.max(5, Math.floor(leaseMs / 3)));
    heartbeatTimer.unref?.();
    let active = this.activeExecutions.get(projectId);
    if (!active) {
      active = new Map();
      this.activeExecutions.set(projectId, active);
    }
    active.set(key, { controller, intentId, heartbeatTimer });
    return controller;
  }

  private finishExecution(projectId: ProjectId, key: string): void {
    const active = this.activeExecutions.get(projectId);
    const execution = active?.get(key);
    if (execution) clearInterval(execution.heartbeatTimer);
    active?.delete(key);
    if (active?.size === 0) this.activeExecutions.delete(projectId);
  }

  private abortExecutions(projectId: ProjectId, intentId?: IntentId): void {
    for (const execution of this.activeExecutions.get(projectId)?.values() ?? []) {
      if (!intentId || execution.intentId === intentId) {
        execution.controller.abort(new Error(intentId
          ? `intent ${intentId} cancelled by directive`
          : "session execution cancelled by directive"));
      }
    }
  }

  /** Revoke persisted leases as well as local AbortControllers. Remote
   * coordinators discover the epoch/status change on their next heartbeat and
   * abort without being able to commit a late result. */
  private cancelPersistedExecutions(projectId: ProjectId, reason: string, intentId?: IntentId): void {
    for (const run of this.graph.subagentRuns(projectId)) {
      if (run.status !== "pending" && run.status !== "running") continue;
      if (intentId && run.intentId !== intentId) continue;
      this.graph.updateSubagentRun(projectId, run.id, {
        status: "cancelled",
        errorMessage: reason,
      });
    }
  }

  /** Per-project, per-intent explorer-failure counts. An intent whose explorer
   *  keeps failing (bad output, backend crash) would otherwise be released back
   *  to "open" and re-dispatched forever — no verdict is ever produced to wake
   *  the planner, so the loop deadlocks. After the profile retry limit the intent
   *  is auto-failed (mechanism, like lease expiry — not a planner policy call)
   *  and recorded as a dead-end so the planner does not re-open the same path. */
  private async maybeRunPlanner(projectId: ProjectId): Promise<boolean> {
    const intents = this.graph.intents(projectId);
    const hints = this.graph.unconsumedHints(projectId);
    const recentVerdicts = this.coordinator.recentVerdicts(projectId);

    const isEmpty = intents.length === 0;
    const hasRecentVerdict = recentVerdicts.length > 0;
    const hasActionableHint = hints.some((h) => h.kind === "stop-explorer" || h.kind === "direction");
    const hasRelevantBroadcast = this.coordinator.hasRelevantBroadcastSincePlanner(projectId);

    const needsPlanning = isEmpty || hasActionableHint || hasRecentVerdict || hasRelevantBroadcast;
    if (!needsPlanning) {
      return true;
    }

    const progress = this.graph.progress(projectId);
    const lastStep = this.coordinator.lastPlannerStep(projectId);
    const { profileId: plannerProfileId, profile: plannerProfile } = this.profileForRole("planner");
    const cooldown = plannerProfile?.cooldownSteps ?? 3;
    const inCooldown = progress.stepsExecuted - lastStep < cooldown;

    // Cooldown only gates re-planning when there is nothing NEW to react to.
    // Any new verdict, actionable hint, or relevant broadcast bypasses cooldown;
    // only repeated empty-state polling is throttled.
    if (inCooldown && !hasRecentVerdict && !hasActionableHint && !hasRelevantBroadcast) {
      return true;
    }
    if (this.coordinator.retryDelayRemaining(
      projectId,
      "planner.error",
      plannerProfile.retry?.backoffMs ?? 0,
      this.coordinator.lastPlannerDecisionSeq(projectId),
    ) > 0) return true;

    const plannerRun = this.graph.createSubagentRun(projectId, {
      profileId: plannerProfileId,
      role: plannerProfile.role,
      workerName: selectProfileWorker(plannerProfile, projectId, this.workerPool, this.config),
      inputSummary: "planner graph decision",
      dispatchKey: "planner",
    });
    const runClaim = this.graph.claimSubagentRun(
      projectId,
      plannerRun.id,
      this.coordinatorId,
      this.config.scheduler?.workerLeaseMs ?? DEFAULT_SCHEDULER.workerLeaseMs,
    );
    if (!runClaim) return true;
    const controller = this.startExecution(projectId, plannerRun.id, runClaim);
    try {
      const agent = new MainAgent({
        project: this.requireProject(projectId), config: this.config,
        workerPool: this.workerPool, promptLoader: this.promptLoader,
        graphReader: this.graphReader,
      });
      const { decision, permissions, runId } = await agent.run({
        hints: hints.length > 0 ? hints : undefined,
        recentVerdicts: hasRecentVerdict ? recentVerdicts : undefined,
        signal: controller.signal,
        runId: plannerRun.id,
        workerName: plannerRun.workerName,
        onRunUpdate: (patch) => this.graph.updateSubagentRun(projectId, plannerRun.id, patch, runClaim),
      });

      this.graph.transaction(() => {
        this.graph.assertSubagentRunClaim(projectId, runId, runClaim);
        if (this.graph.getProject(projectId)?.status !== "active") {
          this.graph.updateSubagentRun(projectId, runId, {
            status: "discarded",
            errorMessage: "planner result arrived after the project left active state",
          }, runClaim);
          this.graph.logEvent(projectId, "planner.result_discarded", { runId });
          return;
        }

        applyMainDecision({
          projectId, graph: this.graph, config: this.config,
          decision, permissions,
        });
        this.graph.updateSubagentRun(projectId, runId, {
          status: "completed",
          outputSummary: `${decision.createIntents.length} create, ${decision.stopExplorerIntentIds.length} stop, ${decision.failIntents.length} fail, end=${Boolean(decision.concludeRun)}`,
        }, runClaim);
        this.graph.logEvent(projectId, "planner.decision_applied", {
          createdIntents: decision.createIntents.length,
          failedIntents: decision.failIntents.length,
          stoppedExplorers: decision.stopExplorerIntentIds.length,
          consumedHints: decision.consumeHintIds.length,
          concluded: Boolean(decision.concludeRun),
          stepsExecuted: this.graph.progress(projectId).stepsExecuted,
        });
      });
      if (this.graph.getSubagentRun(projectId, runId)?.status === "discarded") return false;
      for (const intentId of decision.stopExplorerIntentIds) {
        this.abortExecutions(projectId, intentId);
      }

      return true;
    } catch (err) {
      if (controller.signal.aborted) {
        try {
          this.graph.updateSubagentRun(projectId, plannerRun.id, {
            status: "cancelled",
            errorMessage: err instanceof Error ? err.message : String(err),
          }, runClaim);
          this.graph.logEvent(projectId, "planner.cancelled", { runId: plannerRun.id });
        } catch { /* expired/reassigned attempts cannot change durable state */ }
        return false;
      }
      try {
        this.graph.assertSubagentRunClaim(projectId, plannerRun.id, runClaim);
      } catch {
        return false;
      }
      this.graph.updateSubagentRun(projectId, plannerRun.id, {
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      }, runClaim);
      const failures = this.coordinator.plannerFailureCount(projectId) + 1;
      this.graph.logEvent(projectId, "planner.error", {
        error: err instanceof Error ? err.message : String(err),
        failures,
      });
      if (failures >= (plannerProfile.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        this.graph.updateProjectStatus(projectId, "failed");
        this.graph.logEvent(projectId, "project.failed_retry_exhausted", {
          stage: "planner", failures,
        });
      }
      return false;
    } finally {
      this.finishExecution(projectId, plannerRun.id);
    }
  }

  private async dispatchExplorers(projectId: ProjectId): Promise<number> {
    // Sweep stale leases before counting claimed slots, so an expired claim
    // (worker that crashed/abandoned) frees its slot within the same step
    // rather than blocking dispatch until the next tick. Mirrors Cairn's
    // expire_workers-before-claim pattern.
    this.graph.sweepExpiredLeases();

    const open = this.graph.intents(projectId, "open");
    if (open.length === 0) return 0;

    const requested = open.filter((intent) => intent.dispatchRequested);
    const dispatchable = requested.filter((i) => !this.graph.isDeadEnd(projectId, i.description));
    for (const dead of requested.filter((i) => this.graph.isDeadEnd(projectId, i.description))) {
      this.graph.failIntent(projectId, dead.id, "skipped: matches recorded dead-end", true);
    }
    if (dispatchable.length === 0) return 0;

    const scheduler = this.config.scheduler;
    const maxConcurrent = scheduler?.maxConcurrent ?? DEFAULT_SCHEDULER.maxConcurrent;
    const refillPerTick = scheduler?.refillPerTick ?? DEFAULT_SCHEDULER.refillPerTick;
    const claimedCount = this.graph.intents(projectId, "claimed").length;
    const availableSlots = Math.max(0, maxConcurrent - claimedCount);
    const slots = Math.min(availableSlots, refillPerTick, dispatchable.length);
    if (slots <= 0) return 0;

    let batch = dispatchable.slice(0, slots);

    const { profileId: explorerProfileId, profile: explorerProfile } = this.profileForRole("explorer");
    if (explorerProfile.maxActive !== undefined) {
      const activeRuns = this.graph.subagentRuns(projectId, { profileId: explorerProfileId, status: "running" }).length;
      const inFlight = Math.max(activeRuns, claimedCount);
      if (inFlight >= explorerProfile.maxActive) return 0;
      batch = batch.slice(0, explorerProfile.maxActive - inFlight);
      if (batch.length === 0) return 0;
    }

    await Promise.allSettled(batch.map((intent) => this.runOneExplorer(projectId, intent)));
    return batch.length;
  }

  private async runOneExplorer(projectId: ProjectId, intent: Intent): Promise<void> {
    const leaseMs = this.config.scheduler?.workerLeaseMs ?? DEFAULT_SCHEDULER.workerLeaseMs;

    const { profileId: explorerProfileId, profile: explorerProfile } = this.profileForRole("explorer");
    const explorerWorker = selectProfileWorker(explorerProfile, projectId, this.workerPool, this.config);
    const run = this.graph.createSubagentRun(projectId, {
      profileId: explorerProfileId,
      role: explorerProfile.role,
      workerName: explorerWorker,
      intentId: intent.id,
      inputSummary: intent.description,
      dispatchKey: `${explorerProfileId}:${intent.id}`,
    });
    const runClaim = this.graph.claimSubagentRun(
      projectId,
      run.id,
      this.coordinatorId,
      leaseMs,
    );
    if (!runClaim) return;
    const workerId = `${this.coordinatorId}:${run.id}:${runClaim.attempt}`;
    let controller: AbortController | undefined;
    let claim: IntentLeaseClaim | undefined;

    try {
      const claimed = this.graph.claimIntent(projectId, intent.id, workerId, leaseMs);
      claim = { workerId, epoch: claimed.leaseEpoch };
      controller = this.startExecution(projectId, run.id, runClaim, intent.id, claim);

      const { output, prompt, rawText, usedConclude } = await runSubagentWithText({
        profile: explorerProfile,
        profileId: explorerProfileId,
        project: this.requireProject(projectId),
        workerPool: this.workerPool, config: this.config,
        promptLoader: this.promptLoader,
        graphReader: this.graphReader,
        runId: run.id,
        onRunUpdate: (patch) => this.graph.updateSubagentRun(projectId, run.id, patch, runClaim),
        workerNameOverride: run.workerName,
        signal: controller.signal,
        intent,
        promptExtra: explorerExtra(
          intent.id,
          intent.description,
          intent.parentFactIds,
          [],
          intent.parentFactIds
            .map((factId) => this.graph.getFact(projectId, factId))
            .filter((fact): fact is NonNullable<typeof fact> => Boolean(fact)),
        ),
      });
      const inputTokens = estimateContextTokens(prompt);
      const outputTokens = estimateContextTokens(rawText);

      if (output.kind !== "fact") {
        throw new StageError(`explorer returned kind="${output.kind}", expected "fact"`, "explorer");
      }

      const explorerPermissions = new PermissionChecker(explorerProfile);
      explorerPermissions.require("handle_intent");
      explorerPermissions.require("write_candidate_fact");
      this.graph.updateSubagentRun(projectId, run.id, {
        usedConclude, inputTokens, outputTokens,
      }, runClaim);
      this.graph.commitExplorerResult(projectId, intent.id, run.id, {
        description: output.fact.description,
        evidence: output.fact.evidence,
        source: "explorer",
        confidence: output.fact.confidence,
      }, claim, runClaim);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!controller && !claim) {
        try {
          this.graph.updateSubagentRun(projectId, run.id, {
            status: "discarded",
            errorMessage: reason,
          }, runClaim);
        } catch { /* run was reclaimed while intent claim raced */ }
        return;
      }
      if (controller?.signal.aborted) {
        if (claim) {
          try { this.graph.releaseIntent(projectId, intent.id, claim); } catch { /* already concluded/reassigned */ }
        }
        try {
          this.graph.updateSubagentRun(projectId, run.id, {
            status: "cancelled",
            errorMessage: reason,
          }, runClaim);
          this.graph.logEvent(projectId, "explorer.cancelled", {
            intentId: intent.id,
            runId: run.id,
          });
        } catch { /* expired/reassigned attempt is fenced */ }
        return;
      }
      const currentIntent = this.graph.getIntent(projectId, intent.id);
      const stillOwnsLease = Boolean(claim && currentIntent?.status === "claimed"
        && currentIntent.lease?.workerId === claim.workerId
        && currentIntent.lease.epoch === claim.epoch);
      const leaseExpired = stillOwnsLease
        && Boolean(currentIntent?.lease?.expiresAt && currentIntent.lease.expiresAt <= new Date().toISOString());
      if (claim && (!stillOwnsLease || leaseExpired)) {
        if (stillOwnsLease) {
          try { this.graph.releaseIntent(projectId, intent.id, claim); } catch { /* already reassigned */ }
        }
        try {
          this.graph.updateSubagentRun(projectId, run.id, {
            status: "discarded",
            errorMessage: reason,
          }, runClaim);
          this.graph.logEvent(projectId, "explorer.result_discarded", {
            intentId: intent.id,
            runId: run.id,
            leaseEpoch: claim.epoch,
          });
        } catch { /* run lease was also reassigned */ }
        return;
      }
      try {
        this.graph.assertSubagentRunClaim(projectId, run.id, runClaim);
      } catch {
        return;
      }
      // Track repeated failures. A persistently-broken explorer (bad output,
      // flaky backend) would otherwise re-dispatch the same intent forever — no
      // verdict is produced to wake the planner, so the loop would deadlock.
      // After MAX_EXPLORER_RETRIES, auto-fail the intent (mechanism, like lease
      // expiry — not a planner policy decision) and record it as a dead-end so
      // the planner does not re-open the same path. Below the cap, release the
      // lease so the next tick may retry.
      const fails = this.bumpIntentFailure(projectId, intent.id);
      if (fails >= (explorerProfile.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        if (claim) {
          try { this.graph.releaseIntent(projectId, intent.id, claim); } catch { /* already concluded/reassigned */ }
        }
        this.graph.updateProjectStatus(projectId, "failed");
        this.graph.logEvent(projectId, "project.failed_retry_exhausted", {
          stage: "explorer", intentId: intent.id, failures: fails, lastError: reason,
        });
      } else {
        if (claim) {
          try { this.graph.releaseIntent(projectId, intent.id, claim); } catch { /* already concluded/reassigned */ }
        }
      }
      this.graph.updateSubagentRun(projectId, run.id, { status: "failed", errorMessage: reason }, runClaim);
      this.graph.logEvent(projectId, "explorer.error", { intentId: intent.id, error: reason, runId: run.id });
    } finally {
      this.finishExecution(projectId, run.id);
    }
  }

  /** Count persisted explorer failures so restart cannot reset the retry cap. */
  private bumpIntentFailure(projectId: ProjectId, intentId: IntentId): number {
    return this.coordinator.explorerFailureCount(projectId, intentId) + 1;
  }

  private async runEvaluators(projectId: ProjectId): Promise<void> {
    let candidates = this.graph.candidateFacts(projectId);
    if (candidates.length === 0) return;

    const { profileId: evaluatorProfileId, profile: evaluatorProfile } = this.profileForRole("evaluator");
    if (evaluatorProfile.maxActive !== undefined) {
      const active = this.graph.subagentRuns(projectId, {
        profileId: evaluatorProfileId,
        status: "running",
      }).length;
      candidates = candidates.slice(0, Math.max(0, evaluatorProfile.maxActive - active));
      if (candidates.length === 0) return;
    }
    await Promise.allSettled(
      candidates.map(async (candidate) => {
        const evaluatorWorker = selectProfileWorker(evaluatorProfile, projectId, this.workerPool, this.config);
        const run = this.graph.createSubagentRun(projectId, {
          profileId: evaluatorProfileId,
          role: evaluatorProfile.role,
          workerName: evaluatorWorker,
          factId: candidate.id,
          inputSummary: candidate.description.slice(0, 200),
          dispatchKey: `${evaluatorProfileId}:${candidate.id}`,
        });
        const runClaim = this.graph.claimSubagentRun(
          projectId,
          run.id,
          this.coordinatorId,
          this.config.scheduler?.workerLeaseMs ?? DEFAULT_SCHEDULER.workerLeaseMs,
        );
        if (!runClaim) return;
        const controller = this.startExecution(projectId, run.id, runClaim);
        try {
          const output = await runSubagent({
            profile: evaluatorProfile,
            profileId: evaluatorProfileId,
            project: this.requireProject(projectId),
            workerPool: this.workerPool, config: this.config,
            promptLoader: this.promptLoader,
            graphReader: this.graphReader,
            runId: run.id,
            onRunUpdate: (patch) => this.graph.updateSubagentRun(projectId, run.id, patch, runClaim),
            workerNameOverride: run.workerName,
            signal: controller.signal,
            candidate,
            promptExtra: evaluatorExtra(
              candidate,
              undefined,
              undefined,
              candidate.parentIntentId
                ? (() => {
                    const intent = this.graph.getIntent(projectId, candidate.parentIntentId!);
                    if (!intent) return undefined;
                    return {
                      intent,
                      sourceFacts: intent.parentFactIds
                        .map((factId) => this.graph.getFact(projectId, factId))
                        .filter((fact): fact is NonNullable<typeof fact> => Boolean(fact)),
                    };
                  })()
                : undefined,
            ),
          });

          if (output.kind !== "verdict") {
            throw new StageError(`evaluator returned kind="${output.kind}", expected "verdict"`, "evaluator");
          }

          const evaluatorPermissions = new PermissionChecker(evaluatorProfile);
          evaluatorPermissions.require("change_fact");
          this.graph.commitEvaluatorResult(projectId, candidate.id, run.id, output.verdict, runClaim);

          // Deferred re-evaluation: an accepted fact may satisfy the
          // requiredConditions of a deferred pending fact in this session.
          // This is a LOCAL mechanism (no bus needed); cross-session
          // reactivation goes through the FederationBus deferred/condition_met
          // insights below.
          if (output.verdict.decision === "pass") {
            this.tryReactivateDeferred(projectId, candidate.description);
          }

        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (controller.signal.aborted) {
            try {
              this.graph.updateSubagentRun(projectId, run.id, {
                status: "cancelled",
                errorMessage: reason,
              }, runClaim);
              this.graph.logEvent(projectId, "evaluator.cancelled", {
                factId: candidate.id,
                runId: run.id,
              });
            } catch { /* expired/reassigned attempt is fenced */ }
            return;
          }
          try {
            this.graph.assertSubagentRunClaim(projectId, run.id, runClaim);
          } catch {
            return;
          }
          // Do NOT resolve the fact as "deny" on a transient evaluator error
          // (network/timeout/parse). A spurious reject would permanently mark the
          // fact as a dead-end and pollute later planner decisions. Leave it as a
          // candidate so a later step can retry evaluation.
          this.graph.updateSubagentRun(projectId, run.id, { status: "failed", errorMessage: reason }, runClaim);
          this.graph.logEvent(projectId, "evaluator.error", {
            factId: candidate.id, error: reason, runId: run.id,
            failures: this.bumpEvaluatorFailure(projectId, candidate.id),
          });
          const failures = this.coordinator.evaluatorFailureCount(projectId, candidate.id);
          if (failures >= (evaluatorProfile.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
            && this.graph.getProject(projectId)?.status === "active") {
            this.graph.updateProjectStatus(projectId, "failed");
            this.graph.logEvent(projectId, "project.failed_retry_exhausted", {
              stage: "evaluator", factId: candidate.id, failures,
            });
          }
        } finally {
          this.finishExecution(projectId, run.id);
        }
      }),
    );
  }

  private async processFederationBroadcasts(projectId: ProjectId): Promise<void> {
    if (!this.federationBus || !this.sessionId) return;
    const { profileId: evaluatorProfileId, profile: evaluatorProfile } = this.profileForRole("evaluator");
    const permissions = new PermissionChecker(evaluatorProfile);
    permissions.require("receive_fact_broadcast");

    for (const insight of this.federationBus.pendingForSession(this.sessionId)) {
      const prior = this.graph.events(projectId).find(
        (event) => event.type === "federation.broadcast_assessed"
          && event.payload.broadcastId === insight.id,
      );
      if (prior) {
        this.federationBus.acknowledge(
          this.sessionId,
          insight.id,
          prior.payload.decision === "irrelevant" ? "irrelevant" : "evaluated",
          typeof prior.payload.runId === "string" ? prior.payload.runId : undefined,
        );
        continue;
      }

      const run = this.graph.createSubagentRun(projectId, {
        profileId: evaluatorProfileId,
        role: evaluatorProfile.role,
        workerName: selectProfileWorker(evaluatorProfile, projectId, this.workerPool, this.config),
        inputSummary: `broadcast ${insight.id}: ${insight.summary.slice(0, 160)}`,
        dispatchKey: `${evaluatorProfileId}:broadcast:${insight.id}`,
      });
      const runClaim = this.graph.claimSubagentRun(
        projectId,
        run.id,
        this.coordinatorId,
        this.config.scheduler?.workerLeaseMs ?? DEFAULT_SCHEDULER.workerLeaseMs,
      );
      if (!runClaim) continue;
      const controller = this.startExecution(projectId, run.id, runClaim);
      try {
        const broadcastProfile = {
          ...evaluatorProfile,
          output: { contract: "broadcast_assessment" as const },
        };
        const output = await runSubagent({
          profile: broadcastProfile,
          profileId: evaluatorProfileId,
          project: this.requireProject(projectId),
          workerPool: this.workerPool,
          config: this.config,
          promptLoader: this.promptLoader,
          graphReader: this.graphReader,
          runId: run.id,
          onRunUpdate: (patch) => this.graph.updateSubagentRun(projectId, run.id, patch, runClaim),
          workerNameOverride: run.workerName,
          signal: controller.signal,
          promptExtra: broadcastEvaluatorExtra({
            id: insight.id,
            kind: insight.kind,
            sourceSessionId: insight.source.sessionId,
            sourceProjectId: insight.source.projectId,
            sourceFactId: insight.source.factId,
            summary: insight.summary,
            confidence: insight.confidence,
          }, this.graph.facts(projectId, "pending")),
        });
        if (output.kind !== "broadcast_assessment") {
          throw new StageError(
            `broadcast evaluator returned kind="${output.kind}", expected "broadcast_assessment"`,
            "evaluator",
          );
        }
        if (insight.kind === "session_summary" && output.assessment.decision === "condition_satisfied") {
          throw new StageError(
            "session_summary cannot satisfy a pending Fact condition",
            "evaluator",
          );
        }
        this.graph.commitBroadcastAssessment(
          projectId,
          insight.id,
          run.id,
          output.assessment,
          insight.kind,
          runClaim,
        );
        this.federationBus.acknowledge(
          this.sessionId,
          insight.id,
          output.assessment.decision === "irrelevant" ? "irrelevant" : "evaluated",
          run.id,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (controller.signal.aborted) {
          try {
            this.graph.updateSubagentRun(projectId, run.id, {
              status: "cancelled",
              errorMessage: reason,
            }, runClaim);
            this.graph.logEvent(projectId, "federation.broadcast_cancelled", {
              broadcastId: insight.id,
              runId: run.id,
            });
          } catch { /* expired/reassigned attempt is fenced */ }
          return;
        }
        try {
          this.graph.assertSubagentRunClaim(projectId, run.id, runClaim);
        } catch {
          continue;
        }
        this.graph.updateSubagentRun(projectId, run.id, { status: "failed", errorMessage: reason }, runClaim);
        this.federationBus.markFailed(this.sessionId, insight.id, run.id);
        const failures = this.coordinator.broadcastFailureCount(projectId, insight.id) + 1;
        this.graph.logEvent(projectId, "federation.broadcast_error", {
          broadcastId: insight.id,
          runId: run.id,
          error: reason,
          failures,
        });
        if (failures >= (evaluatorProfile.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
          && this.graph.getProject(projectId)?.status === "active") {
          this.graph.updateProjectStatus(projectId, "failed");
          this.graph.logEvent(projectId, "project.failed_retry_exhausted", {
            stage: "broadcast-evaluator",
            broadcastId: insight.id,
            failures,
          });
          return;
        }
      } finally {
        this.finishExecution(projectId, run.id);
      }
    }
  }

  private flushFederationOutbox(projectId: ProjectId): void {
    if (!this.federationBus || !this.sessionId) return;
    for (const item of this.graph.federationOutbox(projectId, "pending")) {
      try {
        const insight = this.federationBus.publishInsight(
          item.kind,
          {
            sessionId: this.sessionId,
            projectId,
            factId: item.sourceFactId,
          },
          item.summary,
          item.confidence,
          undefined,
          { id: item.eventId, scope: item.scope },
        );
        this.graph.markFederationOutboxPublished(
          projectId,
          item.eventId,
          insight.id,
          insight.seq,
        );
      } catch (error) {
        this.graph.logEvent(projectId, "federation.outbox_publish_error", {
          eventId: item.eventId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Deferred re-evaluation: when a fact is accepted, check whether any local
   * deferred pending fact (one parked on requiredConditions) has its condition
   * satisfied by the newly accepted fact's content. If so, clear the conditions
   * so the deferred fact re-enters the candidateFacts queue for re-evaluation
   * by the evaluator on a subsequent step.
   *
   * Matching is substring-based (the condition text appears in the accepted
   * fact's description). Intentionally conservative — only reactivates on a
   * clear textual match, avoiding false reactivation.
   */
  private tryReactivateDeferred(projectId: ProjectId, acceptedDescription: string): void {
    const deferred = this.graph.facts(projectId, "pending")
      .filter((f) => f.requiredConditions && f.requiredConditions.length > 0);
    const lower = acceptedDescription.toLowerCase();
    for (const fact of deferred) {
      const met = fact.requiredConditions!.some((c) => c && lower.includes(c.toLowerCase()));
      if (met) {
        this.graph.clearFactConditions(projectId, fact.id);
        this.graph.logEvent(projectId, "fact.reactivated", {
          factId: fact.id,
          byFactDescription: acceptedDescription.slice(0, 120),
        });
      }
    }
  }

  private checkTermination(projectId: ProjectId): StepResult | undefined {
    const project = this.graph.getProject(projectId);
    if (!project) return { type: "failed", reason: "project not found" };
    if (project.status !== "active" && project.status !== "finish_proposed") {
      if (project.status === "completed") return { type: "completed" };
      if (project.status === "stopped") return { type: "stopped", reason: "stopped by directive" };
      if (project.status === "failed") return { type: "failed", reason: "project failed" };
      if (project.status === "paused") return { type: "idle", reason: "paused by directive" };
    }

    const progress = this.graph.progress(projectId);
    // Do not terminate naturally if there are deferred pending facts (parked on
    // requiredConditions) — they may be reactivated when a condition is met, so
    // the project still has potential work. Only complete when there is truly
    // nothing left to explore or reactivate.
    const hasDeferred = this.graph.facts(projectId, "pending").some((f) => f.requiredConditions?.length);
    const hasCandidates = this.graph.candidateFacts(projectId).length > 0;
    // Do not terminate while intents are claimed (in-flight explorers). A
    // stuck/expired claim is swept to "open" by the next dispatchExplorers tick,
    // but until then claiming is in-flight work — terminating on openIntents==0
    // alone would cut runs short while a worker is still executing.
    //
    // Do not terminate immediately after a verdict this step produced (accept
    // OR reject/defer): the planner has not yet had a chance to react (chain a
    // downstream trace from an accepted fact, or redirect after a reject). Let
    // the next step's maybeRunPlanner see these verdicts first; the planner is
    // the sole judge of whether the task is done.
    const recentVerdicts = this.coordinator.recentVerdicts(projectId);
    const hasUnconsumedVerdict = recentVerdicts.length > 0;
    if (project.status === "finish_proposed"
      && progress.openIntents === 0 && progress.claimedIntents === 0
      && !hasCandidates && !hasUnconsumedVerdict) {
      const events = this.graph.events(projectId);
      const proposalSeq = [...events].reverse().find((event) => event.type === "planner.end_fact_created")?.seq ?? 0;
      const finalReviewSeq = [...events].reverse().find((event) => event.type === "metacog.final_review_completed")?.seq ?? 0;
      if (this.metacog && finalReviewSeq <= proposalSeq) {
        return { type: "idle", reason: "awaiting final metacog review" };
      }
      if (this.federationBus) {
        return { type: "idle", reason: "awaiting task-group federation barrier" };
      }
      this.graph.updateProjectStatus(projectId, "completed");
      this.graph.logEvent(projectId, "project.completed_standalone", {
        stepsExecuted: progress.stepsExecuted,
        acceptedFacts: progress.passFacts,
      });
      return { type: "completed" };
    }

    if (project.status === "active" && progress.openIntents === 0
      && progress.claimedIntents === 0 && !hasCandidates && !hasUnconsumedVerdict) {
      return {
        type: "idle",
        reason: hasDeferred
          ? "waiting for pending fact conditions or planner end decision"
          : "waiting for planner end decision",
      };
    }

    return undefined;
  }

  private bumpEvaluatorFailure(projectId: ProjectId, factId: string): number {
    return this.coordinator.evaluatorFailureCount(projectId, factId) + 1;
  }

  private requireProject(projectId: ProjectId) {
    const project = this.graph.getProject(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    return project;
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
