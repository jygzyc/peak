/**
 * Runtime wiring for peak.
 *
 * Creates the persistent graph store, worker pool, sessionLoop, metacog supervisor,
 * and HTTP server used by CLI commands. This file is composition-only: domain
 * behavior belongs in agent stages and graph mutations belong in Graph implementations.
 */

import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskConfig, DirectiveInput, ProjectId } from "../agent/types.js";
import type { Graph, ProjectInput } from "../graph/graph.js";
import { SessionManager } from "../session/session-manager.js";
import { AgentDriverPool } from "../worker/agent-driver-pool.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { SessionLoop, type RunOptions, type StepResult } from "../session/session-loop.js";
import { MetacogSupervisor } from "../session/metacog-supervisor.js";
import { HttpServer, type HttpServerOptions } from "../server/http-server.js";
import { sessionsDir } from "../config/peak-home.js";
import { FederationBus } from "../graph/federation-bus.js";
import { GlobalSupervisor } from "../session/supervisor.js";
import { HttpSessionGraphReader, type SessionGraphReader } from "../agent/context-builder.js";

export interface AgentRuntimeOptions {
  baseDir?: string;
  workerPool?: WorkerPool;
  useHttp?: boolean;
  /** Optional shared coordinator. A standalone runtime creates its own bus. */
  federationBus?: FederationBus;
  /** UUID used in every Fact broadcast emitted by this Session's metacog. */
  sessionId?: string;
  federationScope?: string;
  /** Existing global control plane. When provided, createProject registers this
   * session exactly once and run() drives that supervisor instead of creating a
   * second resource governor/federation coordinator. */
  globalSupervisor?: GlobalSupervisor;
  graphReader?: SessionGraphReader;
}

export class AgentRuntime {
  readonly sessionManager: SessionManager;
  readonly workerPool: WorkerPool;
  readonly graph: Graph;
  readonly sessionLoop: SessionLoop;
  readonly metacogSupervisor?: MetacogSupervisor;
  readonly httpServer?: HttpServer;
  private readonly supervisor: GlobalSupervisor;
  private readonly ownsFederationBus: boolean;
  private federationScope?: string;
  private supervisorRegistration?: string;
  private readonly sessionId: string;
  private readonly closeController = new AbortController();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly config: TaskConfig,
    options: AgentRuntimeOptions = {},
  ) {
    if (!options.sessionId) throw new Error("AgentRuntime requires a UUID sessionId");
    this.sessionId = options.sessionId;
    const baseDir = options.baseDir ?? sessionsDir();
    this.sessionManager = new SessionManager(baseDir);
    this.graph = this.sessionManager.open(this.sessionId);

    this.workerPool = options.workerPool ?? new AgentDriverPool();
    const federationBus = options.federationBus
      ?? options.globalSupervisor?.federationBus
      ?? new FederationBus();
    this.ownsFederationBus = !options.federationBus && !options.globalSupervisor;
    if (options.useHttp) this.httpServer = new HttpServer(federationBus);
    const graphReader = options.graphReader ?? (this.httpServer
      ? new HttpSessionGraphReader(() => this.httpServer!.baseUrl)
      : undefined);
    const federationSessionId = this.sessionId;
    this.federationScope = options.federationScope
      ?? config.federation?.scope;
    this.supervisor = options.globalSupervisor ?? new GlobalSupervisor({
      federationBus,
      globalMaxConcurrent: config.scheduler?.maxConcurrent,
    });
    this.sessionLoop = new SessionLoop(this.graph, this.workerPool, config, {
      federationBus,
      sessionId: federationSessionId,
      federationScope: this.federationScope ?? federationSessionId,
      graphReader,
    });

    this.metacogSupervisor = new MetacogSupervisor(
      this.graph,
      this.workerPool,
      config,
      { bus: federationBus, sessionId: federationSessionId, scope: this.federationScope ?? federationSessionId },
      graphReader,
    );
    this.sessionLoop.setMetacog(this.metacogSupervisor);

  }

  createProject(input: {
    session: string;
    target?: string;
    goal?: string;
    name?: string;
    configPath?: string;
  }): ProjectId {
    this.assertOpen();
    const session = input.session;
    const existingProjects = this.graph.listProjects();
    if (existingProjects.length > 0 && !existingProjects.some((project) => project.session === session)) {
      throw new Error("one session runtime may contain only one task/Project");
    }
    this.federationScope ??= this.sessionId;
    const sessionDir = this.sessionManager.sessionDir(this.sessionId);
    const configPath = input.configPath ?? join(sessionDir, "task.json");
    const workspaceDir = this.config.task.workspace
      ? resolve(dirname(configPath), this.config.task.workspace)
      : dirname(configPath);
    const explorerProfile = Object.values(this.config.profiles)
      .find((profile) => profile.role === "explorer");
    if (!explorerProfile) throw new Error("explorer role is not configured");
    const projectInput: ProjectInput = {
      sessionId: this.sessionId,
      session,
      name: input.name ?? session,
      target: input.target ?? this.config.task.target,
      goal: input.goal ?? this.config.task.goal,
      worker: explorerProfile.runtime.worker,
      sessionDir,
      workspaceDir,
      configPath,
      taskConfig: this.config,
    };

    const project = this.graph.createProject(projectInput);
    if (this.httpServer && !this.httpServer.listSessions().some((binding) => binding.sessionId === this.sessionId)) {
      this.httpServer.registerSession({
        sessionId: this.sessionId,
        projectId: project.id,
        graph: this.graph,
        taskGroupScope: this.federationScope,
      });
    }
    if (this.supervisor && !this.supervisorRegistration) {
      this.supervisor.register(this.sessionId, this.sessionLoop, {
        projectId: project.id,
        scope: this.federationScope,
      });
      this.supervisorRegistration = this.sessionId;
    }
    return project.id;
  }

  async step(projectId: ProjectId): Promise<StepResult> {
    this.assertOpen();
    return this.sessionLoop.step(projectId);
  }

  async run(projectId: ProjectId, options?: RunOptions): Promise<StepResult> {
    this.assertOpen();
    const sessionId = this.supervisorRegistration;
    if (!sessionId) throw new Error("AgentRuntime must create its session project before run()");
    const idlePollMs = options?.idlePollMs ?? 50;
    for (let step = 1; ; step += 1) {
      this.assertOpen();
      const results = await this.supervisor.tick();
      this.assertOpen();
      const result = results.find(
        (item) => item.sessionId === sessionId,
      )?.result ?? { type: "idle" as const, reason: "session not scheduled" };
      options?.onStep?.(projectId, step, result);
      if (result.type === "completed" || result.type === "stopped" || result.type === "failed") return result;
      if (result.type === "idle") {
        try {
          await delay(idlePollMs, undefined, { signal: this.closeController.signal });
        } catch (error) {
          if (this.closeController.signal.aborted) throw new Error("agent runtime is closed");
          throw error;
        }
      }
    }
  }

  async tick(): Promise<StepResult[]> {
    this.assertOpen();
    return this.sessionLoop.tick();
  }

  async startHttp(options?: HttpServerOptions): Promise<void> {
    this.assertOpen();
    await this.httpServer?.start(options);
  }

  async stopHttp(): Promise<void> {
    await this.httpServer?.stop();
  }

  addDirective(projectId: ProjectId, input: DirectiveInput): void {
    this.assertOpen();
    this.sessionLoop.addDirective(projectId, input);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closeController.abort();
    this.closePromise = (async () => {
      if (this.supervisorRegistration) {
        this.supervisor?.unregister(this.supervisorRegistration);
        this.supervisorRegistration = undefined;
      }
      this.httpServer?.unregisterSession(this.sessionId);
      const results = await Promise.allSettled([
        this.sessionLoop.close(),
        this.stopHttp(),
      ]);
      this.graph.close?.();
      if (this.ownsFederationBus) this.supervisor.federationBus.close();
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    })();
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("agent runtime is closed");
  }
}
