/**
 * Production composition entry for supervisor-owned sessions.
 *
 * One call creates exactly one session-local AgentRuntime (Graph, SessionLoop,
 * planner binding and MetacogSupervisor), creates/reopens its single Project,
 * and registers the loop with the shared GlobalSupervisor. Domain behavior
 * remains entirely in TaskConfig.
 */
import type { TaskConfig } from "../agent/types.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { AgentRuntime } from "./agent-runtime.js";
import { GlobalSupervisor } from "../session/supervisor.js";
import { HttpServer, type HttpServerOptions } from "../server/http-server.js";
import { HttpSessionGraphReader } from "../agent/context-builder.js";
import { FederationBus } from "../graph/federation-bus.js";
import { SessionManager } from "../session/session-manager.js";

export interface SessionRuntimeFactoryOptions {
  baseDir?: string;
  workerPool?: WorkerPool;
  supervisor?: GlobalSupervisor;
  globalMaxConcurrent?: number;
  useHttp?: boolean;
}

export interface CreatedSessionRuntime {
  sessionId: string;
  projectId: string;
  runtime: AgentRuntime;
}

export interface CreateSessionOptions {
  sessionId?: string;
  name?: string;
  configPath?: string;
}

export class SessionRuntimeFactory {
  readonly supervisor: GlobalSupervisor;
  readonly httpServer?: HttpServer;
  private readonly runtimes = new Map<string, CreatedSessionRuntime>();
  private readonly ownsSupervisor: boolean;
  private readonly sessionManager: SessionManager;
  private closePromise?: Promise<void>;

  constructor(private readonly options: SessionRuntimeFactoryOptions = {}) {
    this.ownsSupervisor = !options.supervisor;
    this.sessionManager = new SessionManager(options.baseDir);
    this.supervisor = options.supervisor ?? new GlobalSupervisor({
      globalMaxConcurrent: options.globalMaxConcurrent,
      federationBus: new FederationBus(),
    });
    if (options.useHttp) this.httpServer = new HttpServer(this.supervisor.federationBus);
  }

  async create(config: TaskConfig, options: CreateSessionOptions = {}): Promise<CreatedSessionRuntime> {
    if (this.closePromise) throw new Error("session runtime factory is closed");
    const name = options.name ?? config.task.name ?? config.task.target;
    const selected = options.sessionId
      ? { id: options.sessionId, name }
      : this.sessionManager.create(name);
    if (options.sessionId) this.sessionManager.activate(selected);
    const sessionId = selected.id;
    if (this.runtimes.has(sessionId) || this.supervisor.get(sessionId)) {
      throw new Error(`session already exists: ${sessionId}`);
    }

    const runtime = new AgentRuntime(config, {
      baseDir: this.options.baseDir,
      workerPool: this.options.workerPool,
      // A factory owns one unified server; individual runtimes must not bind
      // competing ports or expose a partial single-session view.
      useHttp: false,
      globalSupervisor: this.supervisor,
      sessionId,
      federationScope: config.federation?.scope,
      graphReader: this.httpServer
        ? new HttpSessionGraphReader(() => this.httpServer!.baseUrl)
        : undefined,
    });

    try {
      const projectId = runtime.createProject({
        session: selected.name,
        name: selected.name,
        configPath: options.configPath,
      });
      const created = { sessionId, projectId, runtime };
      this.httpServer?.registerSession({
        sessionId,
        projectId,
        graph: runtime.graph,
        taskGroupScope: config.federation?.scope ?? sessionId,
      });
      this.runtimes.set(sessionId, created);
      return created;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  get(sessionId: string): CreatedSessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    const created = this.runtimes.get(sessionId);
    if (!created) return;
    this.httpServer?.unregisterSession(sessionId);
    await created.runtime.close();
    this.runtimes.delete(sessionId);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      const results = await Promise.allSettled([
        this.stopHttp(),
        ...[...this.runtimes.keys()].map((sessionId) => this.closeSession(sessionId)),
      ]);
      if (this.ownsSupervisor) this.supervisor.federationBus.close();
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    })();
    return this.closePromise;
  }

  startHttp(options?: HttpServerOptions): Promise<void> {
    if (this.closePromise) throw new Error("session runtime factory is closed");
    if (!this.httpServer) throw new Error("session runtime factory HTTP server is disabled");
    return this.httpServer.start(options);
  }

  stopHttp(): Promise<void> {
    return this.httpServer?.stop() ?? Promise.resolve();
  }
}
