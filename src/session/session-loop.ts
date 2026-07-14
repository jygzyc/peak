/**
 * Per-session main loop.
 *
 * Drives project steps: directives → planner (MainAgent) → explorers
 * (SubagentRunner) → evaluators (SubagentRunner) → termination. Scheduling and
 * SubagentRun lifecycle live here; role-specific prompt assembly is delegated
 * to SubagentRunner.
 */

import type { Intent, ProjectId, IntentId } from "../agent/types.js";
import { DEFAULT_SCHEDULER } from "../agent/types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { StageError } from "../agent/parse-envelope.js";
import { MainAgent } from "../agent/main-agent.js";
import { applyMainDecision } from "../agent/decision-applier.js";
import {
  runSubagent,
  runSubagentWithText,
  explorerExtra,
  evaluatorExtra,
  type SiblingInsight,
} from "../agent/subagent-runner.js";
import { ContextLedger } from "../agent/context-ledger.js";
import { estimateContextTokens } from "../agent/context-builder.js";
import { WorkerSessionManager } from "../worker/session-manager.js";
import { ProjectLockManager } from "./project-lock.js";
import { PromptLoader } from "../config/prompt-loader.js";
import type { FederationBus } from "../graph/federation-bus.js";
import type { MetacogSupervisor } from "./metacog-supervisor.js";

/** Max times an explorer may fail the same intent before the loop auto-fails it.
 *  Without this cap a persistently-broken explorer (bad output, flaky backend)
 *  releases the intent back to "open" every step and is re-dispatched forever —
 *  no verdict is ever produced to wake the planner, so the loop deadlocks. */
const MAX_EXPLORER_RETRIES = 3;

export type StepResult =
  | { type: "stepped"; intentsDispatched: number; factsAccepted: number }
  | { type: "idle"; reason: string }
  | { type: "completed" }
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
  /** Metacog supervisor driven synchronously inside each step (after
   * evaluators, before termination). When set, metacog reviews the graph and
   * emits correction hints the planner consumes on the next step. */
  metacog?: MetacogSupervisor;
}

export class SessionLoop {
  private locks = new ProjectLockManager();
  readonly contextLedger = new ContextLedger();
  readonly sessionManager = new WorkerSessionManager();
  private stepVerdicts = new Map<ProjectId, Array<{ factId: string; verdict: import("../agent/types.js").Verdict; intentId?: string }>>();
  readonly locks_: ProjectLockManager;
  private readonly promptLoader: PromptLoader;
  private readonly federationBus?: FederationBus;
  private readonly sessionId?: string;
  private readonly metacog?: MetacogSupervisor;

  constructor(
    private readonly graph: Graph,
    private readonly workerPool: WorkerPool,
    private readonly config: import("../agent/types.js").TaskConfig,
    options: SessionLoopOptions = {},
  ) {
    this.locks_ = this.locks;
    this.promptLoader = new PromptLoader();
    this.federationBus = options.federationBus;
    this.sessionId = options.sessionId;
    this.metacog = options.metacog;
  }

  /** Inject the metacog supervisor after construction. Used by AgentRuntime,
   * which must build the SessionLoop first (for its lock) and then the
   * MetacogSupervisor sharing that lock. */
  setMetacog(metacog: MetacogSupervisor): void {
    (this as unknown as { metacog?: MetacogSupervisor }).metacog = metacog;
  }

  async step(projectId: ProjectId): Promise<StepResult> {
    return this.locks.acquire(projectId, async () => this.stepLocked(projectId));
  }

  async tick(): Promise<StepResult[]> {
    this.graph.sweepExpiredLeases();
    const active = this.graph.listProjects("active");
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
      if (lastResult.type === "completed" || lastResult.type === "failed") break;
      if (lastResult.type === "idle") await sleep(idlePollMs);
    }
    return lastResult;
  }

  private async stepLocked(projectId: ProjectId): Promise<StepResult> {
    const project = this.graph.getProject(projectId);
    if (!project) return { type: "failed", reason: "project not found" };

    this.graph.sweepExpiredLeases();

    await this.consumeDirectives(projectId);
    const current = this.graph.getProject(projectId)!;
    if (current.status !== "active") {
      if (current.status === "completed" || current.status === "stopped") return { type: "completed" };
      if (current.status === "failed") return { type: "failed", reason: "project failed" };
      return { type: "idle", reason: `project status=${current.status}` };
    }

    const factsBefore = this.graph.facts(projectId, "pass").length;

    await this.maybeRunPlanner(projectId);
    const dispatched = await this.dispatchExplorers(projectId);
    await this.runEvaluators(projectId);

    // Metacog runs synchronously inside the step (the lock is already held),
    // after evaluators have produced verdicts but before termination is
    // decided. It reviews the graph and may emit correction hints that the
    // planner consumes on the next step. This replaces the async 30s timer,
    // which could not keep up with the step cadence.
    if (this.metacog) {
      await this.metacog.runForProjectLocked(projectId);
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
          this.graph.logEvent(projectId, "directive.stop", { reason: dir.payload });
          return;
        case "pause":
          this.graph.updateProjectStatus(projectId, "paused");
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
          try {
            this.graph.failIntent(projectId, dir.payload, "killed by directive", false);
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

  private lastPlannerStep = new Map<ProjectId, number>();
  /** Per-project, per-intent explorer-failure counts. An intent whose explorer
   *  keeps failing (bad output, backend crash) would otherwise be released back
   *  to "open" and re-dispatched forever — no verdict is ever produced to wake
   *  the planner, so the loop deadlocks. After MAX_EXPLORER_RETRIES the intent
   *  is auto-failed (mechanism, like lease expiry — not a planner policy call)
   *  and recorded as a dead-end so the planner does not re-open the same path. */
  private readonly intentFailures = new Map<ProjectId, Map<IntentId, number>>();

  private async maybeRunPlanner(projectId: ProjectId): Promise<void> {
    const intents = this.graph.intents(projectId);
    const hints = this.graph.unconsumedHints(projectId);
    const recentVerdicts = this.stepVerdicts.get(projectId) ?? [];

    const isEmpty = intents.length === 0;
    const hasRejectOrDefer = recentVerdicts.some((v) => v.verdict.decision !== "pass");
    // An accepted fact is a verified node the planner may chain a downstream
    // trace intent from (e.g. entrypoint -> control-flow trace). Without this,
    // the loop stops after the first accept instead of exhausting the surface.
    const hasAccept = recentVerdicts.some((v) => v.verdict.decision === "pass");
    const hasRecentVerdict = recentVerdicts.length > 0;
    const hasActionableHint = hints.some((h) => h.kind === "stop-explorer" || h.kind === "direction");

    const needsPlanning = isEmpty || hasActionableHint || hasRecentVerdict;
    if (!needsPlanning) {
      this.stepVerdicts.set(projectId, []);
      return;
    }

    const progress = this.graph.progress(projectId);
    const lastStep = this.lastPlannerStep.get(projectId) ?? -99;
    const plannerProfile = this.config.profiles[this.config.control?.mainProfile ?? "planner"];
    const cooldown = plannerProfile?.cooldownSteps ?? 3;
    const inCooldown = progress.stepsExecuted - lastStep < cooldown;

    // Cooldown only gates re-planning when there is nothing NEW to react to.
    // Reject/defer/accept verdicts and actionable hints bypass cooldown so the
    // planner can redirect or chain immediately; pure-empty idle is the only
    // path that respects cooldown (it will run unconditionally anyway).
    if (inCooldown && !hasRejectOrDefer && !hasAccept && !hasActionableHint) {
      this.stepVerdicts.set(projectId, []);
      return;
    }

    try {
      const agent = new MainAgent({
        projectId, graph: this.graph, config: this.config,
        workerPool: this.workerPool, promptLoader: this.promptLoader,
        contextLedger: this.contextLedger, sessionManager: this.sessionManager,
      });
      const { decision, permissions } = await agent.run({
        hints: hints.length > 0 ? hints : undefined,
        recentVerdicts: hasRecentVerdict ? recentVerdicts : undefined,
      });

      applyMainDecision({
        projectId, graph: this.graph, config: this.config,
        decision, permissions,
      });

      this.stepVerdicts.set(projectId, []);
      this.lastPlannerStep.set(projectId, progress.stepsExecuted);
    } catch (err) {
      this.graph.logEvent(projectId, "planner.error", {
        error: err instanceof Error ? err.message : String(err),
      });
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

    const dispatchable = open.filter((i) => !this.graph.isDeadEnd(projectId, i.description));
    for (const dead of open.filter((i) => this.graph.isDeadEnd(projectId, i.description))) {
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

    const explorerProfile = this.config.profiles.explorer;
    if (explorerProfile.maxActive !== undefined) {
      const activeRuns = this.graph.subagentRuns(projectId, { profileId: "explorer", status: "running" }).length;
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
    const workerId = `w-${intent.id}-${Date.now().toString(36)}`;

    const explorerProfile = this.config.profiles.explorer;
    const run = this.graph.createSubagentRun(projectId, {
      profileId: "explorer",
      role: explorerProfile.role,
      workerName: explorerProfile.runtime.workers?.[0] ?? explorerProfile.runtime.worker,
      intentId: intent.id,
      inputSummary: intent.description,
    });

    try {
      this.graph.claimIntent(projectId, intent.id, workerId, leaseMs);
      this.graph.updateSubagentRun(projectId, run.id, { status: "running" });

      const { output, prompt, rawText, usedDelta, usedConclude } = await runSubagentWithText({
        profile: explorerProfile,
        profileId: "explorer",
        projectId, graph: this.graph,
        workerPool: this.workerPool, config: this.config,
        promptLoader: this.promptLoader,
        contextLedger: this.contextLedger,
        sessionManager: this.sessionManager,
        intent,
        promptExtra: explorerExtra(intent.id, intent.description, intent.parentFactIds, []),
      });
      const inputTokens = estimateContextTokens(prompt);
      const outputTokens = estimateContextTokens(rawText);

      if (output.kind !== "fact") {
        throw new StageError(`explorer returned kind="${output.kind}", expected "fact"`, "explorer");
      }

      const fact = this.graph.addFact(projectId, {
        description: output.fact.description,
        evidence: output.fact.evidence,
        source: "explorer",
        confidence: output.fact.confidence,
        parentIntentId: intent.id,
      });
      this.graph.concludeIntent(projectId, intent.id, fact.id);
      this.clearIntentFailure(projectId, intent.id);
      this.graph.updateSubagentRun(projectId, run.id, {
        status: "completed",
        factId: fact.id,
        outputSummary: output.fact.description.slice(0, 200),
        usedDelta, usedConclude, inputTokens, outputTokens,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Track repeated failures. A persistently-broken explorer (bad output,
      // flaky backend) would otherwise re-dispatch the same intent forever — no
      // verdict is produced to wake the planner, so the loop would deadlock.
      // After MAX_EXPLORER_RETRIES, auto-fail the intent (mechanism, like lease
      // expiry — not a planner policy decision) and record it as a dead-end so
      // the planner does not re-open the same path. Below the cap, release the
      // lease so the next tick may retry.
      const fails = this.bumpIntentFailure(projectId, intent.id);
      if (fails >= MAX_EXPLORER_RETRIES) {
        try {
          this.graph.failIntent(projectId, intent.id, `explorer failed ${fails}x: ${reason}`, true);
          this.clearIntentFailure(projectId, intent.id);
          this.graph.logEvent(projectId, "intent.auto_failed", { intentId: intent.id, failures: fails, lastError: reason });
        } catch { /* already concluded/failed */ }
      } else {
        try {
          this.graph.releaseIntent(projectId, intent.id);
        } catch { /* already concluded/released */ }
      }
      this.graph.updateSubagentRun(projectId, run.id, { status: "failed", errorMessage: reason });
      this.graph.logEvent(projectId, "explorer.error", { intentId: intent.id, error: reason, runId: run.id });
    }
  }

  /** Increment the explorer-failure count for an intent; return the new count. */
  private bumpIntentFailure(projectId: ProjectId, intentId: IntentId): number {
    let pm = this.intentFailures.get(projectId);
    if (!pm) { pm = new Map(); this.intentFailures.set(projectId, pm); }
    const n = (pm.get(intentId) ?? 0) + 1;
    pm.set(intentId, n);
    return n;
  }

  /** Clear the failure count (intent was concluded/failed/reclaimed elsewhere). */
  private clearIntentFailure(projectId: ProjectId, intentId: IntentId): void {
    this.intentFailures.get(projectId)?.delete(intentId);
  }

  private async runEvaluators(projectId: ProjectId): Promise<void> {
    const candidates = this.graph.pendingCandidates(projectId);
    if (candidates.length === 0) return;

    const evaluatorProfile = this.config.profiles.evaluator;
    const siblings = this.collectSiblingInsights();

    await Promise.allSettled(
      candidates.map(async (candidate) => {
        const run = this.graph.createSubagentRun(projectId, {
          profileId: "evaluator",
          role: evaluatorProfile.role,
          workerName: evaluatorProfile.runtime.worker,
          factId: candidate.id,
          inputSummary: candidate.description.slice(0, 200),
        });
        try {
          this.graph.updateSubagentRun(projectId, run.id, { status: "running" });

          const output = await runSubagent({
            profile: evaluatorProfile,
            profileId: "evaluator",
            projectId, graph: this.graph,
            workerPool: this.workerPool, config: this.config,
            promptLoader: this.promptLoader,
            contextLedger: this.contextLedger,
            sessionManager: this.sessionManager,
            candidate,
            promptExtra: evaluatorExtra(candidate, siblings.facts, siblings.deadEnds),
          });

          if (output.kind !== "verdict") {
            throw new StageError(`evaluator returned kind="${output.kind}", expected "verdict"`, "evaluator");
          }

          this.graph.resolveFact(projectId, candidate.id, output.verdict);

          // Deferred re-evaluation: an accepted fact may satisfy the
          // requiredConditions of a deferred pending fact in this session.
          // This is a LOCAL mechanism (no bus needed); cross-session
          // reactivation goes through the FederationBus deferred/condition_met
          // insights below.
          if (output.verdict.decision === "pass") {
            this.tryReactivateDeferred(projectId, candidate.description);
          }

          // Cross-session propagation.
          if (this.federationBus && this.sessionId) {
            if (output.verdict.decision === "pass") {
              this.federationBus.publishInsight(
                "fact",
                { sessionId: this.sessionId, projectId, factId: candidate.id },
                candidate.description,
                candidate.confidence,
              );
            } else if (output.verdict.decision === "deny") {
              // A rejected fact marks a proven dead-end direction (auto-recorded
              // inside resolveFact via recordDeadEnd). Broadcast so siblings prune.
              this.federationBus.publishInsight(
                "dead_end",
                { sessionId: this.sessionId, projectId, factId: candidate.id },
                candidate.description,
                candidate.confidence,
              );
            } else if (output.verdict.decision === "pending") {
              // Deferred: the fact is real but blocked on conditions. Broadcast
              // the requiredConditions so sibling sessions that hold a condition
              // can notify this session to re-evaluate.
              this.federationBus.publishInsight(
                "pending",
                { sessionId: this.sessionId, projectId, factId: candidate.id },
                candidate.description,
                candidate.confidence,
                output.verdict.requiredConditions,
              );
            }
          }

          const verdicts = this.stepVerdicts.get(projectId) ?? [];
          verdicts.push({
            factId: candidate.id,
            verdict: output.verdict,
            intentId: candidate.parentIntentId,
          });
          this.stepVerdicts.set(projectId, verdicts);

          this.graph.updateSubagentRun(projectId, run.id, {
            status: "completed",
            outputSummary: `${output.verdict.decision}: ${output.verdict.reason.slice(0, 150)}`,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // Do NOT resolve the fact as "deny" on a transient evaluator error
          // (network/timeout/parse). A spurious reject would permanently mark the
          // fact as a dead-end and pollute later planner decisions. Leave it as a
          // candidate so a later step can retry evaluation.
          this.graph.updateSubagentRun(projectId, run.id, { status: "failed", errorMessage: reason });
          this.graph.logEvent(projectId, "evaluator.error", {
            factId: candidate.id, error: reason, runId: run.id,
          });
        }
      }),
    );
  }

  /**
   * Pull cross-session insights from the FederationBus to show the evaluator as
   * read-only corroboration. Federation facts never enter the local graph — the
   * evaluator sees what siblings have verified or ruled out and cross-validates
   * the local candidate against it. Each runEvaluators call re-pulls (the bus is
   * a read-only recentInsights snapshot, idempotent); no per-project dedup cursor
   * is needed because the context is "all sibling findings so far" and the
   * evaluator decides relevance itself.
   */
  private collectSiblingInsights(): {
    facts: SiblingInsight[];
    deadEnds: SiblingInsight[];
  } {
    if (!this.federationBus || !this.sessionId) return { facts: [], deadEnds: [] };
    const facts: SiblingInsight[] = [];
    const deadEnds: SiblingInsight[] = [];
    for (const ins of this.federationBus.recentInsights()) {
      if (ins.source.sessionId === this.sessionId) continue;
      if (ins.kind === "fact") {
        facts.push({
          summary: ins.summary,
          confidence: ins.confidence,
          fromSession: ins.source.sessionId,
        });
      } else if (ins.kind === "dead_end") {
        deadEnds.push({
          summary: ins.summary,
          confidence: ins.confidence,
          fromSession: ins.source.sessionId,
        });
      }
    }
    return { facts, deadEnds };
  }

  /**
   * Deferred re-evaluation: when a fact is accepted, check whether any local
   * deferred pending fact (one parked on requiredConditions) has its condition
   * satisfied by the newly accepted fact's content. If so, clear the conditions
   * so the deferred fact re-enters the pendingCandidates queue for re-evaluation
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
    if (project.status !== "active") {
      if (project.status === "completed" || project.status === "stopped") return { type: "completed" };
      if (project.status === "failed") return { type: "failed", reason: "project failed" };
      if (project.status === "paused") return { type: "idle", reason: "paused by directive" };
    }

    // Natural termination: this is an unbounded exploration/blackboard agent.
    // It completes when the planner can produce no new intent AND none are in
    // flight — i.e. there is nothing left to explore. There is no depth limit,
    // no stop gate, and no forced stagnation pause; stagnation instead triggers
    // the metacog loop (which emits hints the planner acts on). The planner is
    // the sole judge of whether the task is done.
    const progress = this.graph.progress(projectId);
    // Do not terminate naturally if there are deferred pending facts (parked on
    // requiredConditions) — they may be reactivated when a condition is met, so
    // the project still has potential work. Only complete when there is truly
    // nothing left to explore or reactivate.
    const hasDeferred = this.graph.facts(projectId, "pending").some((f) => f.requiredConditions?.length);
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
    const recentVerdicts = this.stepVerdicts.get(projectId) ?? [];
    const hasUnconsumedVerdict = recentVerdicts.length > 0;
    if (progress.openIntents === 0 && progress.claimedIntents === 0 && !hasDeferred && !hasUnconsumedVerdict) {
      this.graph.updateProjectStatus(projectId, "completed");
      this.graph.logEvent(projectId, "project.completed_natural", {
        stepsExecuted: progress.stepsExecuted,
        acceptedFacts: progress.passFacts,
      });
      return { type: "completed" };
    }

    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
