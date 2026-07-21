/**
 * Session-local metacognition trigger.
 *
 * Runs once for every pass Fact and once for the final completion proposal.
 */

import type { Fact, ProjectId, TaskConfig } from "../agent/types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { selectProfileWorker } from "../agent/base-agent.js";
import { MetacogAgent } from "../agent/role-agents.js";
import { metacogExtra } from "../agent/prompt-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { PermissionChecker } from "../agent/permissions.js";
import type { FactBroadcast, FederationBus } from "../graph/federation-bus.js";
import { appendGraphOperation, graphOperations } from "../server/graph-operation-log.js";
import type { GlobalResourceGovernor } from "../worker/resource-governor.js";
import type { SessionGraphReader } from "../agent/context-builder.js";
import { ServerSessionGraphReader } from "../server/session-graph-reader.js";

export class MetacogSupervisor {
  private closed = false;
  private readonly promptLoader: PromptLoader;
  private readonly activeControllers = new Map<ProjectId, {
    controller: AbortController;
  }>();
  private readonly inFlightProjects = new Map<ProjectId, Promise<boolean>>();
  private resourceGovernor?: GlobalResourceGovernor;
  private federation?: { bus: FederationBus; sessionId: string; scope: string };

  constructor(
    private readonly graph: Graph,
    private workerPool: WorkerPool,
    private readonly config: TaskConfig,
    federation?: { bus: FederationBus; sessionId: string; scope?: string },
    graphReader?: SessionGraphReader,
  ) {
    this.graphReader = graphReader ?? new ServerSessionGraphReader(graph);
    if (federation) {
      this.setFederation(
        federation.bus,
        federation.sessionId,
        federation.scope ?? config.federation?.scope ?? federation.sessionId,
      );
    }
    this.promptLoader = new PromptLoader();
  }

  setFederation(bus: FederationBus, sessionId: string, scope = "default"): void {
    if (this.closed) throw new Error("MetacogSupervisor is closed");
    this.federation = { bus, sessionId, scope };
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

  async close(): Promise<void> {
    this.closed = true;
    for (const active of this.activeControllers.values()) {
      active.controller.abort(new Error("metacog supervisor closed"));
    }
    await Promise.allSettled([...this.inFlightProjects.values()]);
  }

  interrupt(projectId: ProjectId): void {
    this.activeControllers.get(projectId)?.controller.abort(new Error("metacog cancelled by directive"));
  }

  async runOnce(): Promise<void> {
    const active = this.graph.listProjects()
      .filter((project) => project.status === "active" || project.status === "finish_proposed");
    await Promise.allSettled(active.map((p) => this.runForProject(p.id)));
  }

  hasCompletedFinalReview(projectId: ProjectId): boolean {
    const project = this.graph.getProject(projectId);
    const endFact = this.graph.activeEndFact(projectId);
    if (!project || !endFact) return false;
    return graphOperations(project, "final_review")
      .some((entry) => entry.changes.endFactId === endFact.id);
  }

  /** Concurrent SessionLoop calls for one project share the same promise. */
  async runForProject(projectId: ProjectId): Promise<boolean> {
    if (this.closed) return false;
    const existing = this.inFlightProjects.get(projectId);
    if (existing) return existing;
    const current = Promise.resolve().then(async () => {
      let ran = false;
      do {
        const executed = await this.executeForProject(projectId);
        ran ||= executed;
        if (!executed) break;
      } while (this.hasPendingFactReview(projectId));
      return ran;
    }).finally(() => {
      if (this.inFlightProjects.get(projectId) === current) {
        this.inFlightProjects.delete(projectId);
      }
    });
    this.inFlightProjects.set(projectId, current);
    return current;
  }

  private async executeForProject(projectId: ProjectId): Promise<boolean> {
    const project = this.graph.getProject(projectId);
    if (!project || (project.status !== "active" && project.status !== "finish_proposed")) return false;
    const selected = Object.entries(this.config.profiles)
      .find(([, candidate]) => candidate.role === "metacog");
    if (!selected) return false;
    const [metacogProfileId, profile] = selected;

    const reviewedFactIds = new Set(graphOperations(project, "review_fact")
      .map((entry) => typeof entry.changes.factId === "string" ? entry.changes.factId : undefined)
      .filter((factId): factId is string => Boolean(factId)));
    const factToReview = this.graph.facts(projectId, "pass")
      .find((fact) => !reviewedFactIds.has(fact.id));
    const finalReview = project.status === "finish_proposed"
      && !this.hasCompletedFinalReview(projectId);

    if (!factToReview && !finalReview) return false;

    const trigger = factToReview ? `fact.accepted:${factToReview.id}` : "final-review";

    const maxActive = profile.maxActive ?? 1;
    if (this.activeControllers.size >= maxActive) return false;

    const workerName = selectProfileWorker(profile, this.workerPool, this.config);
    const agent = new MetacogAgent({
      profileId: metacogProfileId,
      profile,
      project,
      workerPool: this.workerPool,
      config: this.config,
      promptLoader: this.promptLoader,
      graphReader: this.graphReader,
    });
    const controller = new AbortController();
    this.activeControllers.set(projectId, { controller });

    try {
      const permissions = new PermissionChecker(profile);
      const result = await agent.run({
        workerName,
        signal: controller.signal,
        inputSummary: trigger,
        promptExtra: metacogExtra(trigger),
      });

      if (result.output.kind === "hints") {
        permissions.require("create_hint");
        const finalReviewCompleted = finalReview && !factToReview
          && result.output.hints.hints.length === 0
          && this.graph.getProject(projectId)?.status === "finish_proposed";
        const broadcast = this.buildBroadcast(factToReview);
        if (broadcast) permissions.require("send_fact_broadcast");
        if (broadcast) this.federation!.bus.publish(broadcast);
        this.graph.commitMetacogResult(projectId, {
          hints: result.output.hints.hints,
        });
        if (result.output.hints.hints.length > 0) {
          appendGraphOperation(project, metacogProfileId, "create_hint", {
            count: result.output.hints.hints.length,
          });
        }
        if (factToReview) {
          appendGraphOperation(project, metacogProfileId, "review_fact", { factId: factToReview.id });
        }
        if (finalReviewCompleted) {
          appendGraphOperation(project, metacogProfileId, "final_review", {
            endFactId: this.graph.activeEndFact(projectId)?.id,
          });
        }
        if (broadcast) {
          appendGraphOperation(project, metacogProfileId, "send_fact_broadcast", {
            factId: broadcast.factId,
            reason: broadcast.reason,
          });
        }
        return true;
      } else {
        permissions.require("create_hint");
        const hint = {
          creator: profile.role,
          kind: "warning" as const,
          content: `Metacog recommends ending or redirecting the task: ${result.output.stop.reason}`,
        };
        const broadcast = this.buildBroadcast(factToReview);
        if (broadcast) permissions.require("send_fact_broadcast");
        if (broadcast) this.federation!.bus.publish(broadcast);
        this.graph.commitMetacogResult(projectId, {
          hints: [hint],
        });
        appendGraphOperation(project, metacogProfileId, "create_hint", { count: 1 });
        if (factToReview) {
          appendGraphOperation(project, metacogProfileId, "review_fact", { factId: factToReview.id });
        }
        if (broadcast) {
          appendGraphOperation(project, metacogProfileId, "send_fact_broadcast", {
            factId: broadcast.factId,
            reason: broadcast.reason,
          });
        }
        return true;
      }
    } catch (err) {
      return false;
    } finally {
      const active = this.activeControllers.get(projectId);
      if (active?.controller === controller) {
        this.activeControllers.delete(projectId);
      }
    }
  }

  private buildBroadcast(fact: Fact | undefined): FactBroadcast | undefined {
    if (!this.federation || !fact) return undefined;
    return {
      sessionId: this.federation.sessionId,
      factId: fact.id,
      reason: fact.reviewerReason ?? "Fact passed evaluator review",
    };
  }

  private hasPendingFactReview(projectId: ProjectId): boolean {
    const project = this.graph.getProject(projectId);
    if (!project) return false;
    const reviewed = new Set(graphOperations(project, "review_fact")
      .map((entry) => entry.changes.factId)
      .filter((factId): factId is string => typeof factId === "string"));
    return this.graph.facts(projectId, "pass").some((fact) => !reviewed.has(fact.id));
  }

  private readonly graphReader: SessionGraphReader;
}
