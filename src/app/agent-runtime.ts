/**
 * Runtime wiring for peak.
 *
 * Creates the persistent graph store, worker pool, sessionLoop, metacog supervisor,
 * and HTTP server used by CLI commands. This file is composition-only: domain
 * behavior belongs in agent stages and graph mutations belong in Graph implementations.
 */

import { join } from "node:path";
import type { TaskConfig, DirectiveInput, ProjectId } from "../agent/types.js";
import type { Graph, ProjectInput } from "../graph/graph.js";
import { SessionManager } from "../session/session-manager.js";
import { InMemoryGraph } from "../graph/in-memory-graph.js";
import { AgentDriverPool } from "../worker/agent-driver-pool.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { SessionLoop, type RunOptions, type StepResult } from "../session/session-loop.js";
import { MetacogSupervisor } from "../session/metacog-supervisor.js";
import { HttpServer } from "../server/http-server.js";
import { sessionsDir } from "../config/peak-home.js";
import { FederationBus } from "../graph/federation-bus.js";

export interface AgentRuntimeOptions {
  baseDir?: string;
  host?: string;
  port?: number;
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
}

export class AgentRuntime {
  readonly sessionManager: SessionManager;
  readonly workerPool: WorkerPool;
  readonly graph: Graph;
  readonly sessionLoop: SessionLoop;
  readonly metacogSupervisor?: MetacogSupervisor;
  readonly httpServer?: HttpServer;
  private readonly projects = new Map<string, { config: TaskConfig; sessionDir: string }>();

  constructor(
    private readonly config: TaskConfig,
    options: AgentRuntimeOptions = {},
  ) {
    // Default to the ~/.peak/sessions layout when no baseDir is given. When
    // baseDir is unset we still use an in-memory graph (the CLI run command
    // passes its own sessionDir); when set, the graph is persisted under it.
    const baseDir = options.baseDir ?? sessionsDir();
    this.sessionManager = new SessionManager(baseDir);

    if (options.baseDir) {
      const session = config.task.session ?? "default";
      this.graph = this.sessionManager.open(session);
    } else {
      this.graph = new InMemoryGraph();
    }

    this.workerPool = options.workerPool ?? new AgentDriverPool();
    this.sessionLoop = new SessionLoop(this.graph, this.workerPool, config, {
      federationBus: options.federationBus,
      sessionId: options.sessionId,
    });

    if (options.useMetacogSupervisor !== false) {
      // Metacog shares the SessionLoop's project lock so it can run
      // synchronously inside stepLocked (which already holds the lock).
      this.metacogSupervisor = new MetacogSupervisor(this.graph, this.workerPool, config, this.sessionLoop.locks_);
      this.sessionLoop.setMetacog(this.metacogSupervisor);
    }

    if (options.useHttp !== false) {
      this.httpServer = new HttpServer(this.graph, this.sessionLoop);
    }
  }

  createProject(input: {
    session: string;
    target?: string;
    goal?: string;
    name?: string;
    configPath?: string;
  }): ProjectId {
    const session = input.session;
    const sessionDir = this.sessionManager?.sessionDir(session) ?? process.cwd();
    const projectInput: ProjectInput = {
      session,
      name: input.name ?? session,
      target: input.target ?? this.config.task.target,
      goal: input.goal ?? this.config.task.goal,
      worker: this.config.profiles.explorer.runtime.worker,
      sessionDir,
      configPath: input.configPath ?? join(sessionDir, "task.json"),
      taskConfig: this.config,
    };

    const project = this.graph.createProject(projectInput);
    this.projects.set(project.id, { config: this.config, sessionDir });
    return project.id;
  }

  async step(projectId: ProjectId): Promise<StepResult> {
    return this.sessionLoop.step(projectId);
  }

  async run(projectId: ProjectId, options?: RunOptions): Promise<StepResult> {
    return this.sessionLoop.run(projectId, options);
  }

  async tick(): Promise<StepResult[]> {
    return this.sessionLoop.tick();
  }

  startMetacog(): void {
    this.metacogSupervisor?.start();
  }

  stopMetacog(): void {
    this.metacogSupervisor?.stop();
  }

  async startHttp(options?: { host?: string; port?: number }): Promise<void> {
    await this.httpServer?.start(options);
  }

  async stopHttp(): Promise<void> {
    await this.httpServer?.stop();
  }

  addDirective(projectId: ProjectId, input: DirectiveInput): void {
    this.graph.addDirective(projectId, input);
  }

  close(): void {
    this.stopMetacog();
    void this.stopHttp();
    const g = this.graph as unknown as { close?: () => void };
    if (g && typeof g.close === "function") g.close();
  }
}
