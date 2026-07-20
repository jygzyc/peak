/**
 * Per-session main loop.
 *
 * Drives project steps: directives → planner → explorers → evaluators →
 * termination. Live execution control stays here; BaseAgent writes role audit
 * JSON separately from Graph.
 */

import type {
  Directive, DirectiveInput, Intent, ProjectId, IntentId, ProjectStatus,
  SessionRole, SubagentProfile, TaskConfig,
} from "../agent/types.js";
import { DEFAULT_SCHEDULER } from "../agent/types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { StageError } from "../agent/parse-envelope.js";
import { MainAgent } from "../agent/main-agent.js";
import { applyMainDecision } from "../agent/decision-applier.js";
import { selectProfileWorker } from "../agent/base-agent.js";
import { EvaluatorAgent, ExplorerAgent } from "../agent/role-agents.js";
import { explorerExtra, evaluatorExtra, broadcastEvaluatorExtra } from "../agent/prompt-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import type { FederationBus } from "../graph/federation-bus.js";
import type { MetacogSupervisor } from "./metacog-supervisor.js";
import { PermissionChecker, PermissionDeniedError } from "../agent/permissions.js";
import type { GlobalResourceGovernor } from "../worker/resource-governor.js";
import { SessionCoordinator } from "./session-coordinator.js";
import type { Permission } from "../agent/types.js";
import type { SessionGraphReader } from "../agent/context-builder.js";
import { ServerSessionGraphReader } from "../server/session-graph-reader.js";
import { appendGraphOperation } from "../server/graph-operation-log.js";

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
  /** Process-local coordinator for metacog's pass-Fact broadcasts. */
  federationBus?: FederationBus;
  /** This Session's source identity in `{sessionId, factId, reason}`. */
  sessionId?: string;
  /** Task-group broadcast visibility boundary. */
  federationScope?: string;
  /** Metacog supervisor driven synchronously inside each step (after
   * evaluators, before termination). When set, metacog reviews the graph and
   * emits correction hints the planner consumes on the next step. */
  metacog?: MetacogSupervisor;
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
    role: SessionRole;
  }>>();
  private resourceGovernor?: GlobalResourceGovernor;
  private readonly coordinator: SessionCoordinator;
  private readonly graphReader: SessionGraphReader;

  constructor(
    private readonly graph: Graph,
    private workerPool: WorkerPool,
    private readonly config: TaskConfig,
    options: SessionLoopOptions = {},
  ) {
    for (const role of ["planner", "explorer", "evaluator", "metacog"] as const) {
      if (!Object.values(config.profiles).some((profile) => profile.role === role)) {
        throw new Error(`${role} role is not configured`);
      }
    }
    const existingProjects = graph.listProjects();
    if (existingProjects.length > 1) {
      throw new Error(
        "SessionLoop requires exactly one task/Project per session; use GlobalSupervisor for multiple sessions",
      );
    }
    for (const project of existingProjects) {
      for (const intent of graph.intents(project.id, "claimed")) {
        graph.releaseIntent(project.id, intent.id);
      }
    }
    this.promptLoader = new PromptLoader();
    this.graphReader = options.graphReader ?? new ServerSessionGraphReader(graph);
    this.coordinator = new SessionCoordinator();
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
    this.metacog?.setFederation(bus, sessionId, scope);
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
    const projects = this.graph.listProjects();
    const projectId = projects.length === 1 ? projects[0]!.id : undefined;
    const current = this.federationRegistration;
    if (current?.bus === bus && current.sessionId === sessionId
      && current.scope === scope && current.projectId === projectId) return;
    bus.registerSession(sessionId, scope, projectId, this.graph);
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
    const found = Object.entries(this.config.profiles).find(([, profile]) => profile.role === role);
    if (!found) throw new Error(`${role} role is not configured`);
    return { profileId: found[0], profile: found[1] };
  }

  private explorerProfileForIntent(intentId: string): { profileId: string; profile: SubagentProfile } {
    const profiles = Object.entries(this.config.profiles)
      .filter(([, profile]) => profile.role === "explorer");
    if (profiles.length === 0) throw new Error("explorer role is not configured");
    let hash = 0;
    for (const char of intentId) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    const selected = profiles[hash % profiles.length]!;
    return { profileId: selected[0], profile: selected[1] };
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
    if ((this.activeExecutions.get(projectId)?.size ?? 0) > 0) return false;

    if (this.metacog && !this.metacog.hasCompletedFinalReview(projectId)) return false;
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
    if (this.federationBus && this.sessionId) {
      metacog.setFederation(this.federationBus, this.sessionId, this.federationScope);
    }
    if (this.resourceGovernor) metacog.setResourceGovernor(this.resourceGovernor);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const executions of this.activeExecutions.values()) {
      for (const execution of executions.values()) {
        execution.controller.abort(new Error("session loop closed"));
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
      this.abortExecutions(projectId);
      this.metacog?.interrupt(projectId);
    } else if (input.kind === "pause") {
      this.graph.updateProjectStatus(projectId, "paused");
      this.abortExecutions(projectId);
      this.metacog?.interrupt(projectId);
    } else if (input.kind === "resume") {
      this.graph.updateProjectStatus(projectId, "active");
    } else if (input.kind === "kill-intent") {
      this.abortExecutions(projectId, input.payload);
      try {
        this.graph.failIntent(projectId, input.payload, "killed by directive", false, "directive");
      } catch { /* intent may not exist or may already be terminal */ }
    }
    return directive;
  }

  async tick(): Promise<StepResult[]> {
    if (this.closed) throw new Error("SessionLoop is closed");
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

    await this.consumeDirectives(projectId);
    const current = this.graph.getProject(projectId)!;
    if (current.status !== "active" && current.status !== "finish_proposed") {
      if (current.status === "completed") return { type: "completed" };
      if (current.status === "stopped") return { type: "stopped", reason: "stopped by directive" };
      if (current.status === "failed") return { type: "failed", reason: "project failed" };
      return { type: "idle", reason: `project status=${current.status}` };
    }

    const factsBefore = this.graph.facts(projectId, "pass").length;

    const finishing = current.status === "finish_proposed";
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
    await this.processFederationBroadcasts(projectId);
    await this.consumeDirectives(projectId);
    const afterBroadcastControl = this.controlResult(projectId);
    if (afterBroadcastControl) return afterBroadcastControl;

    // Metacog uses an in-flight promise without holding a process-local mutex
    // during worker I/O. It reviews the graph
    // after evaluator verdicts and before termination, so correction hints are
    // visible to the planner on the next step.
    if (this.metacog) {
      await this.metacog.runForProject(projectId);
    }
    await this.consumeDirectives(projectId);
    const afterMetacogControl = this.controlResult(projectId);
    if (afterMetacogControl) return afterMetacogControl;
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
          this.abortExecutions(projectId);
          return;
        case "pause":
          this.graph.updateProjectStatus(projectId, "paused");
          this.abortExecutions(projectId);
          return;
        case "resume":
          this.graph.updateProjectStatus(projectId, "active");
          break;
        case "hint":
          this.graph.addHint(projectId, { content: dir.payload, creator: "human" });
          break;
        case "kill-intent":
          this.abortExecutions(projectId, dir.payload);
          try {
            this.graph.failIntent(projectId, dir.payload, "killed by directive", false, "directive");
          } catch { /* intent may not exist */ }
          break;
        case "spawn-intent":
          this.graph.addIntent(projectId, { description: dir.payload, creator: "human" });
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
    role: SessionRole,
    intentId?: IntentId,
  ): AbortController {
    const controller = new AbortController();
    let active = this.activeExecutions.get(projectId);
    if (!active) {
      active = new Map();
      this.activeExecutions.set(projectId, active);
    }
    active.set(key, { controller, intentId, role });
    return controller;
  }

  private finishExecution(projectId: ProjectId, key: string): void {
    const active = this.activeExecutions.get(projectId);
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

  /** Process-local, per-intent explorer-failure counts. An intent whose explorer
   *  keeps failing (bad output, backend crash) would otherwise be released back
   *  to "open" and re-dispatched forever — no verdict is ever produced to wake
   *  the planner, so the loop deadlocks. After the profile retry limit the intent
   *  causes the Project to fail without turning a transport error into a
   *  semantic Intent denial or dead-end. */
  private async maybeRunPlanner(projectId: ProjectId): Promise<boolean> {
    const intents = this.graph.intents(projectId);
    const hints = this.graph.unconsumedHints(projectId);
    const recentVerdicts = this.coordinator.recentVerdicts(projectId);

    const isEmpty = intents.length === 0;
    const hasRecentVerdict = recentVerdicts.length > 0;
    const hasHint = hints.length > 0;
    const hasRelevantBroadcast = this.coordinator.hasRelevantBroadcastSincePlanner(projectId);

    const needsPlanning = isEmpty || hasHint || hasRecentVerdict || hasRelevantBroadcast;
    if (!needsPlanning) {
      return true;
    }

    const progress = this.graph.progress(projectId);
    const lastStep = this.coordinator.lastPlannerStep(projectId);
    const { profileId: plannerProfileId, profile: plannerProfile } = this.profileForRole("planner");
    const cooldown = plannerProfile?.cooldownSteps ?? 3;
    const inCooldown = progress.stepsExecuted - lastStep < cooldown;

    // Cooldown only gates re-planning when there is nothing NEW to react to.
    // Any new verdict, Hint, or relevant broadcast bypasses cooldown;
    // only repeated empty-state polling is throttled.
    if (inCooldown && !hasRecentVerdict && !hasHint && !hasRelevantBroadcast) {
      return true;
    }
    if (this.coordinator.retryDelayRemaining(
      projectId,
      "planner",
      plannerProfile.retry?.backoffMs ?? 0,
    ) > 0) return true;

    const workerName = selectProfileWorker(plannerProfile, this.workerPool, this.config);
    const executionKey = "planner";
    const controller = this.startExecution(projectId, executionKey, "planner");
    const agent = new MainAgent({
      project: this.requireProject(projectId),
      config: this.config,
      workerPool: this.workerPool,
      promptLoader: this.promptLoader,
      graphReader: this.graphReader,
    });
    try {
      const { decision, permissions } = await agent.run({
        hints: hints.length > 0 ? hints : undefined,
        recentVerdicts: hasRecentVerdict ? recentVerdicts : undefined,
        signal: controller.signal,
        workerName,
      });

      if (this.graph.getProject(projectId)?.status !== "active") {
        return false;
      }
      const applied = this.graph.transaction(() => {
        return applyMainDecision({
          projectId, graph: this.graph, config: this.config,
          decision, permissions,
        });
      });
      if (applied.intentsCreated || applied.explorersStopped || applied.intentsFailed
        || applied.hintsConsumed || applied.concluded) {
        appendGraphOperation(this.requireProject(projectId), plannerProfileId, "apply_decision", { ...applied });
      }
      this.coordinator.recordPlannerDecision(projectId, this.graph.progress(projectId).stepsExecuted);
      for (const intentId of decision.stopExplorerIntentIds) {
        this.abortExecutions(projectId, intentId);
      }

      return true;
    } catch {
      if (controller.signal.aborted) {
        return false;
      }
      const failures = this.coordinator.recordFailure(projectId, "planner");
      if (failures >= (plannerProfile.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        this.graph.updateProjectStatus(projectId, "failed");
      }
      return false;
    } finally {
      this.finishExecution(projectId, executionKey);
    }
  }

  private async dispatchExplorers(projectId: ProjectId): Promise<number> {
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

    await Promise.allSettled(batch.map((intent) => this.runOneExplorer(projectId, intent)));
    return batch.length;
  }

  private async runOneExplorer(projectId: ProjectId, intent: Intent): Promise<void> {
    const { profileId: explorerProfileId, profile: explorerProfile } = this.explorerProfileForIntent(intent.id);
    const explorerWorker = selectProfileWorker(explorerProfile, this.workerPool, this.config);
    const executionKey = `explorer:${intent.id}`;
    let controller: AbortController | undefined;
    let agent: ExplorerAgent | undefined;

    try {
      this.graph.claimIntent(projectId, intent.id);
      controller = this.startExecution(projectId, executionKey, "explorer", intent.id);
      agent = new ExplorerAgent({
        profile: explorerProfile,
        profileId: explorerProfileId,
        project: this.requireProject(projectId),
        workerPool: this.workerPool,
        config: this.config,
        promptLoader: this.promptLoader,
        graphReader: this.graphReader,
      });
      const result = await agent.run({
        workerName: explorerWorker,
        signal: controller.signal,
        intent,
        inputSummary: intent.description,
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
      const explorerPermissions = new PermissionChecker(explorerProfile);
      explorerPermissions.require("handle_intent");
      explorerPermissions.require("write_candidate_fact");
      const fact = this.graph.commitExplorerResult(projectId, intent.id, {
        description: result.output.fact.description,
        evidence: result.output.fact.evidence,
        source: "explorer",
        confidence: result.output.fact.confidence,
      });
      appendGraphOperation(this.requireProject(projectId), explorerProfileId, "write_candidate_fact", {
        intentId: intent.id,
        factId: fact.id,
      });
    } catch {
      if (!controller) return;
      if (controller?.signal.aborted) {
        try { this.graph.releaseIntent(projectId, intent.id); } catch { /* already concluded */ }
        return;
      }
      if (this.graph.getIntent(projectId, intent.id)?.status !== "claimed") {
        return;
      }
      // A persistently broken explorer would otherwise re-dispatch forever.
      // Release the Intent for retry below the cap; once exhausted, fail the
      // Project without inventing a semantic dead-end or denying the Intent.
      const fails = this.bumpIntentFailure(projectId, intent.id);
      if (fails >= (explorerProfile.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        try { this.graph.releaseIntent(projectId, intent.id); } catch { /* already concluded */ }
        this.graph.updateProjectStatus(projectId, "failed");
      } else {
        try { this.graph.releaseIntent(projectId, intent.id); } catch { /* already concluded */ }
      }
    } finally {
      this.finishExecution(projectId, executionKey);
    }
  }

  private bumpIntentFailure(projectId: ProjectId, intentId: IntentId): number {
    return this.coordinator.recordFailure(projectId, `explorer:${intentId}`);
  }

  private async runEvaluators(projectId: ProjectId): Promise<void> {
    let candidates = this.graph.candidateFacts(projectId);
    if (candidates.length === 0) return;

    const { profileId: evaluatorProfileId, profile: evaluatorProfile } = this.profileForRole("evaluator");
    if (evaluatorProfile.maxActive !== undefined) {
      const active = [...this.activeExecutions.get(projectId)?.values() ?? []]
        .filter((execution) => execution.role === "evaluator").length;
      candidates = candidates.slice(0, Math.max(0, evaluatorProfile.maxActive - active));
      if (candidates.length === 0) return;
    }
    await Promise.allSettled(
      candidates.map(async (candidate) => {
        const evaluatorWorker = selectProfileWorker(evaluatorProfile, this.workerPool, this.config);
        const executionKey = `evaluator:${candidate.id}`;
        const controller = this.startExecution(projectId, executionKey, "evaluator");
        const agent = new EvaluatorAgent({
          profileId: evaluatorProfileId,
          profile: evaluatorProfile,
          project: this.requireProject(projectId),
          workerPool: this.workerPool,
          config: this.config,
          promptLoader: this.promptLoader,
          graphReader: this.graphReader,
        });
        try {
          const result = await agent.run({
            workerName: evaluatorWorker,
            signal: controller.signal,
            candidate,
            inputSummary: candidate.description.slice(0, 200),
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
          const evaluatorPermissions = new PermissionChecker(evaluatorProfile);
          evaluatorPermissions.require("change_fact");
          this.graph.commitEvaluatorResult(projectId, candidate.id, result.output.verdict);
          appendGraphOperation(this.requireProject(projectId), evaluatorProfileId, "change_fact", {
            factId: candidate.id,
            decision: result.output.verdict.decision,
            reason: result.output.verdict.reason,
          });
          this.coordinator.recordVerdict(projectId, {
            factId: candidate.id,
            intentId: candidate.parentIntentId,
            verdict: result.output.verdict,
          });

          // Deferred re-evaluation: an accepted fact may satisfy the
          // requiredConditions of a deferred pending fact in this session.
          // This is a LOCAL mechanism (no bus needed); cross-session
          // reactivation is decided when the target evaluator handles the
          // source Session's unified Fact broadcast.
          if (result.output.verdict.decision === "pass") {
            this.tryReactivateDeferred(projectId, candidate.description);
          }

        } catch {
          if (controller.signal.aborted) {
            return;
          }
          // Do NOT resolve the fact as "deny" on a transient evaluator error
          // (network/timeout/parse). A spurious reject would permanently mark the
          // fact as a dead-end and pollute later planner decisions. Leave it as a
          // candidate so a later step can retry evaluation.
          const failures = this.bumpEvaluatorFailure(projectId, candidate.id);
          if (failures >= (evaluatorProfile.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
            && this.graph.getProject(projectId)?.status === "active") {
            this.graph.updateProjectStatus(projectId, "failed");
          }
        } finally {
          this.finishExecution(projectId, executionKey);
        }
      }),
    );
  }

  private async processFederationBroadcasts(projectId: ProjectId): Promise<void> {
    if (!this.federationBus || !this.sessionId) return;
    const { profileId: evaluatorProfileId, profile: evaluatorProfile } = this.profileForRole("evaluator");
    const permissions = new PermissionChecker(evaluatorProfile);
    permissions.require("receive_fact_broadcast");

    for (const broadcast of this.federationBus.pendingForSession(this.sessionId)) {
      const sourceFact = this.federationBus.sourceFact(broadcast);
      if (!sourceFact) continue;
      const evaluatorWorker = selectProfileWorker(evaluatorProfile, this.workerPool, this.config);
      const executionKey = `broadcast:${broadcast.sessionId}:${broadcast.factId}`;
      const controller = this.startExecution(projectId, executionKey, "evaluator");
      const agent = new EvaluatorAgent({
        profileId: evaluatorProfileId,
        profile: evaluatorProfile,
        project: this.requireProject(projectId),
        workerPool: this.workerPool,
        config: this.config,
        promptLoader: this.promptLoader,
        graphReader: this.graphReader,
      });
      try {
        const result = await agent.runBroadcast({
          workerName: evaluatorWorker,
          signal: controller.signal,
          inputSummary: `broadcast ${broadcast.sessionId}/${broadcast.factId}`,
          promptExtra: broadcastEvaluatorExtra({
            ...broadcast,
            fact: sourceFact,
          }, this.graph.facts(projectId, "pending")),
        });
        if (result.output.assessment.decision === "condition_satisfied") {
          const targetFactId = result.output.assessment.targetFactId!;
          if (this.graph.getFact(projectId, targetFactId)?.status !== "pending") {
            throw new StageError(`broadcast target is not a pending Fact: ${targetFactId}`, "evaluator");
          }
          this.graph.clearFactConditions(projectId, targetFactId);
        }
        appendGraphOperation(this.requireProject(projectId), evaluatorProfileId, "receive_fact_broadcast", {
          sourceSessionId: broadcast.sessionId,
          factId: broadcast.factId,
          reason: broadcast.reason,
          decision: result.output.assessment.decision,
        });
        if (result.output.assessment.decision !== "irrelevant") {
          this.coordinator.recordRelevantBroadcast(projectId);
        }
        this.federationBus.markHandled(this.sessionId, broadcast);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const failures = this.coordinator.recordFailure(
          projectId,
          `broadcast:${broadcast.sessionId}:${broadcast.factId}`,
        );
        if (failures >= (evaluatorProfile.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
          && this.graph.getProject(projectId)?.status === "active") {
          this.graph.updateProjectStatus(projectId, "failed");
          return;
        }
      } finally {
        this.finishExecution(projectId, executionKey);
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
      if (this.metacog && !this.metacog.hasCompletedFinalReview(projectId)) {
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
    return this.coordinator.recordFailure(projectId, `evaluator:${factId}`);
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
