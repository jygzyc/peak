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
  useMetacogSupervisor?: boolean;
  /** Shared cross-session insight bus. When set (with sessionId), this runtime's
   *  evaluator publishes local verdicts and cross-validates candidates against
   *  facts siblings have already verified. */
  federationBus?: FederationBus;
  /** This session's id, used as source attribution on published insights and to
   *  skip own insights when pulling sibling corroboration. */
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
  private readonly supervisor?: GlobalSupervisor;
  private federationScope?: string;
  private supervisorRegistration?: string;
  private boundSession?: string;
  private readonly closeController = new AbortController();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly config: TaskConfig,
    options: AgentRuntimeOptions = {},
  ) {
    if (config.task.session && options.sessionId && config.task.session !== options.sessionId) {
      throw new Error(
        `AgentRuntime session mismatch: task.session is "${config.task.session}" but options.sessionId is "${options.sessionId}"`,
      );
    }
    this.boundSession = options.sessionId ?? config.task.session;
    if (!this.boundSession) {
      throw new Error("AgentRuntime requires task.session or options.sessionId before construction");
    }
    const baseDir = options.baseDir ?? sessionsDir();
    this.sessionManager = new SessionManager(baseDir);
    this.graph = this.sessionManager.open(this.boundSession);

    this.workerPool = options.workerPool ?? new AgentDriverPool();
    const federationBus = options.federationBus ?? options.globalSupervisor?.federationBus;
    if (options.useHttp) this.httpServer = new HttpServer(federationBus);
    const graphReader = options.graphReader ?? (this.httpServer
      ? new HttpSessionGraphReader(() => this.httpServer!.baseUrl)
      : undefined);
    const federationSessionId = this.boundSession;
    this.federationScope = options.federationScope
      ?? config.federation?.scope;
    this.supervisor = options.globalSupervisor ?? (federationBus
      ? new GlobalSupervisor({
        federationBus,
        globalMaxConcurrent: config.control?.globalMaxConcurrent,
      })
      : undefined);
    this.sessionLoop = new SessionLoop(this.graph, this.workerPool, config, {
      federationBus,
      sessionId: federationSessionId,
      federationScope: this.federationScope ?? federationSessionId,
      graphReader,
    });

    if (options.useMetacogSupervisor !== false) {
      this.metacogSupervisor = new MetacogSupervisor(
        this.graph,
        this.workerPool,
        config,
        undefined,
        federationSessionId && federationBus
          ? { bus: federationBus, sessionId: federationSessionId, scope: this.federationScope ?? federationSessionId }
          : undefined,
        graphReader,
      );
      this.sessionLoop.setMetacog(this.metacogSupervisor);
    }

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
    if (this.boundSession && this.boundSession !== session) {
      throw new Error(
        `AgentRuntime is bound to session "${this.boundSession}"; create a separate runtime and register it with GlobalSupervisor for session "${session}"`,
      );
    }
    const existingProjects = this.graph.listProjects();
    if (existingProjects.length > 0 && !existingProjects.some((project) => project.session === session)) {
      throw new Error("one session runtime may contain only one task/Project");
    }
    this.boundSession = session;
    this.federationScope ??= session;
    const sessionDir = this.sessionManager.sessionDir(session);
    const configPath = input.configPath ?? join(sessionDir, "task.json");
    const workspaceDir = this.config.task.workspace
      ? resolve(dirname(configPath), this.config.task.workspace)
      : dirname(configPath);
    const explorerProfileId = this.config.control?.explorerProfile ?? "explorer";
    const explorerProfile = this.config.profiles[explorerProfileId];
    if (!explorerProfile || explorerProfile.role !== "explorer") {
      throw new Error(`explorer profile "${explorerProfileId}" is missing or has the wrong role`);
    }
    const projectInput: ProjectInput = {
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
    if (this.httpServer && !this.httpServer.listSessions().some((binding) => binding.sessionId === session)) {
      this.httpServer.registerSession({
        sessionId: session,
        projectId: project.id,
        graph: this.graph,
        taskGroupScope: this.federationScope,
      });
    }
    if (this.supervisor && !this.supervisorRegistration) {
      this.supervisor.register(session, this.sessionLoop, {
        projectId: project.id,
        scope: this.federationScope,
      });
      this.supervisorRegistration = session;
    }
    return project.id;
  }

  async step(projectId: ProjectId): Promise<StepResult> {
    this.assertOpen();
    return this.sessionLoop.step(projectId);
  }

  async run(projectId: ProjectId, options?: RunOptions): Promise<StepResult> {
    this.assertOpen();
    if (!this.supervisor) return this.sessionLoop.run(projectId, options);
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

  startMetacog(): void {
    this.assertOpen();
    this.metacogSupervisor?.start();
  }

  stopMetacog(): void {
    this.metacogSupervisor?.stop();
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
      this.stopMetacog();
      if (this.supervisorRegistration) {
        this.supervisor?.unregister(this.supervisorRegistration);
        this.supervisorRegistration = undefined;
      }
      if (this.boundSession) this.httpServer?.unregisterSession(this.boundSession);
      const results = await Promise.allSettled([
        this.sessionLoop.close(),
        this.stopHttp(),
      ]);
      this.graph.close?.();
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    })();
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("agent runtime is closed");
  }
}
