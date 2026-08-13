import { basename } from "node:path";
import { projectDir as projectDirPath, initializePeakPaths, initializeProjectsDirectory } from "../utils/paths.js";
import { writeProjectLog } from "../utils/helpers.js";
import type { InstalledSkill, ResolvedTaskConfig, TaskProjectConfig } from "../utils/types.js";
import { cleanupTaskSkills, initializeTaskSkills } from "../utils/task-skill-installer.js";
import { HttpJointPlan } from "../graph/http-joint-plan.js";
import { GraphClient, GraphClientError, type ProjectRegistrationInput } from "../graph/graph-client.js";
import { type ProjectMeta } from "../graph/types.js";
import { ExecutionRegistry } from "./execution-registry.js";
import { ProjectLoop } from "./project-loop.js";
import { RuntimeScheduler } from "./scheduler.js";
import { TaskExecutor } from "./task-executor.js";
import { workerDefinitions, WorkerPool } from "./worker-pool.js";
import { LocalBackend } from "./local-backend.js";
import type { ExecutionBackend } from "./execution-backend.js";
import { WorkerRuntime } from "../worker/worker-runtime.js";
import { PROJECT_LEASE_HEARTBEAT_MS } from "../utils/project-registry.js";

export interface RuntimeOptions {
  peakHome?: string;
  installSkills?: boolean;
  /**
   * URL of the independent `peak serve` process. Dispatch never embeds a
   * Graph server or opens a Project store directly.
   */
  graphUrl: string;
  /** Local Projects root used to re-anchor relative Artifact paths. */
  projectsRoot?: string;
  /** Server-owned Project lease identity. Omit only for direct library/test runtimes. */
  registration?: Omit<ProjectRegistrationInput, "projectIds">;
  /** Stops the owning foreground process when a heartbeat proves lease loss. */
  onLeaseLost?: (error: Error) => void;
}

export class AgentRuntime {
  private scheduler?: RuntimeScheduler;
  private client?: GraphClient;
  private projectsDir?: string;
  private firstProjectId?: string;
  private readonly projectIds = new Map<number, string>();
  private readonly executors = new Map<string, TaskExecutor>();
  private readonly executions = new ExecutionRegistry();
  private backend?: ExecutionBackend;
  private taskSkills?: InstalledSkill[];
  private readonly leasedProjectIds: string[] = [];
  private readonly leaseExpiresAt = new Map<string, number>();
  private leaseHeartbeat?: ReturnType<typeof setInterval>;
  private heartbeatInFlight = false;
  private leaseLost = false;

  constructor(readonly config: ResolvedTaskConfig, readonly options: RuntimeOptions) {}

  /** Attaches configured Projects, acquires their leases, then starts their independent ProjectLoops. */
  async start(projectSelector?: string, projectId?: string): Promise<ProjectMeta[]> {
    if (this.client) throw new Error("runtime already started");
    try {
      if (this.options.installSkills !== false) this.taskSkills = initializeTaskSkills(this.config);
      this.projectsDir = this.options.projectsRoot
        ? initializeProjectsDirectory(this.options.projectsRoot)
        : initializePeakPaths(this.options.peakHome).projectsDir;
      this.client = new GraphClient(this.options.graphUrl, { projectsRoot: this.projectsDir });
      this.scheduler = new RuntimeScheduler(this.config, this.executions);
      this.backend = this.createBackend();
      if (this.config.board.projects.some((project) => !project.id)) {
        throw new Error("Dispatch requires prepared Project ids; run `peak prepare --graph-url <url>` first");
      }
      const projects: ProjectMeta[] = [];
      if (projectId) {
        projects.push(await this.attachProject(projectId, projectSelector));
      } else if (projectSelector) {
        projects.push(await this.addProject(projectSelector));
      } else {
        for (let index = 0; index < this.config.board.projects.length; index++) {
          projects.push(await this.ensureProject(index));
        }
      }
      this.requireFederationProjectIds();
      await this.acquireProjectLeases(projects);
      this.scheduler.start();
      return projects;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** Acquires every selected Project under one immutable Task Federation mount. */
  private async acquireProjectLeases(projects: ProjectMeta[]): Promise<void> {
    if (!this.options.registration || !this.client) return;
    const input: ProjectRegistrationInput = {
      ...this.options.registration,
      projectIds: this.requireFederationProjectIds(),
    };
    try {
      for (const project of projects) {
        const lease = await this.client.registerProject(project.id, input);
        this.leasedProjectIds.push(project.id);
        this.leaseExpiresAt.set(project.id, Date.parse(lease.expiresAt));
      }
    } catch (error) {
      await this.releaseProjectLeases();
      throw error;
    }
    this.leaseHeartbeat = setInterval(() => void this.heartbeatProjectLeases(), PROJECT_LEASE_HEARTBEAT_MS);
    this.leaseHeartbeat.unref();
  }

  /** Renews owned Project leases and stops scheduling after authoritative loss. */
  private async heartbeatProjectLeases(): Promise<void> {
    if (this.heartbeatInFlight || !this.client || !this.options.registration) return;
    this.heartbeatInFlight = true;
    try {
      for (const id of this.leasedProjectIds) {
        try {
          const lease = await this.client.heartbeatProject(id, this.options.registration.runtimeId);
          this.leaseExpiresAt.set(id, Date.parse(lease.expiresAt));
        } catch (error) {
          const expired = Date.now() >= (this.leaseExpiresAt.get(id) ?? 0);
          if ((error instanceof GraphClientError && error.status === 409) || expired) {
            this.handleLeaseLoss(error);
            break;
          }
          // A transient transport failure before the last Server-issued
          // expiry is retried on the next heartbeat; it is not lease loss yet.
        }
      }
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private handleLeaseLoss(error: unknown): void {
    if (this.leaseLost) return;
    this.leaseLost = true;
    this.scheduler?.stop();
    const failure = error instanceof Error ? error : new Error(String(error));
    this.options.onLeaseLost?.(failure);
  }

  /** Releases all Project leases best-effort during shutdown or partial startup. */
  private async releaseProjectLeases(): Promise<void> {
    if (!this.client || !this.options.registration) return;
    const projectIds = this.leasedProjectIds.splice(0);
    this.leaseExpiresAt.clear();
    await Promise.all(projectIds.map(async (id) => {
      try { await this.client!.deregisterProject(id, this.options.registration!.runtimeId); }
      catch { /* Lease may already have expired or the Server may be gone. */ }
    }));
  }

  /** Returns the complete static Task mount or rejects unsafe sharded startup. */
  private requireFederationProjectIds(): string[] {
    const ids = this.config.board.projects.map((project, index) => this.projectIds.get(index) ?? project.id);
    const missing = ids.findIndex((id) => !id);
    if (missing >= 0) {
      throw new Error(`Task Federation requires every Project id before sharded dispatch: project-${missing + 1}`);
    }
    return ids as string[];
  }

  private async addProject(projectSelector: string): Promise<ProjectMeta> {
    const index = this.projectIndex(projectSelector);
    return this.ensureProject(index);
  }

  private async attachProject(projectId: string, projectSelector?: string): Promise<ProjectMeta> {
    if (!this.client) throw new Error("runtime not started");
    const graph = await this.client.getProject(projectId);
    const source = graph.facts.find((fact) => fact.id === "origin")?.description;
    const goal = graph.facts.find((fact) => fact.id === "goal")?.description;
    const candidates = projectSelector
      ? [this.workProject(this.projectIndex(projectSelector))]
      : this.config.board.projects.map((_project, index) => this.workProject(index));
    const matches = candidates.filter((project) => (!project.id || project.id === projectId)
      && source === project.source && goal === project.goal);
    if (matches.length === 0) throw new Error("Board config does not match persisted Project");
    if (matches.length > 1) throw new Error("persisted Project matches multiple configured Projects; select one with --project <source>");
    const matched = matches[0]!;
    const index = Number.parseInt(matched.key.slice("project-".length), 10) - 1;
    this.projectIds.set(index, projectId);
    return this.registerProject(graph.project, { ...matched, id: projectId });
  }

  private projectIndex(selector: string): number {
    const index = this.config.board.projects.findIndex((project, item) => project.source === selector || `project-${item + 1}` === selector);
    if (index < 0) throw new Error(`configured Project not found: ${selector}`);
    return index;
  }

  private workProject(index: number): TaskProjectConfig {
    const project = this.config.board.projects[index];
    if (!project) throw new Error(`configured Project not found: project-${index + 1}`);
    return {
      ...project,
      id: this.projectIds.get(index) ?? project.id,
      key: `project-${index + 1}`,
    };
  }

  private async ensureProject(index: number): Promise<ProjectMeta> {
    const configured = this.workProject(index);
    if (configured.id) return this.attachProject(configured.id, configured.source);
    throw new Error(`Dispatch requires a prepared Project id: ${configured.source}`);
  }

  /** Builds one Project-scoped executor, worker pool, Joint Plan adapter, and loop. */
  private async registerProject(project: ProjectMeta, configured: TaskProjectConfig): Promise<ProjectMeta> {
    if (!this.client || !this.projectsDir || !this.scheduler || !this.backend) throw new Error("runtime not started");
    // A stopped Project is reactivated the moment a Runtime takes its lease:
    // stopping a Task (or the dashboard status toggle) parks Projects, and
    // the next start/resume must bring them back to active or the loop would
    // observe a non-active Project and never schedule work again.
    if (project.status === "stopped") {
      project = await this.client.setStatus(project.id, "active");
    }
    const projectDir = projectDirPath(this.projectsDir, project.id);
    const jointPlan = new HttpJointPlan(
      this.client,
      this.config.board.name ?? basename(this.config.taskDir),
      this.config.board.projects.length,
    );
    const workspace = await this.backend.ensureWorkspace(project.id, projectDir);
    const executor = new TaskExecutor(
      this.config,
      configured,
      this.client,
      new WorkerPool(this.config, new WorkerRuntime(workerDefinitions(this.config))),
      jointPlan,
      projectDir,
      () => this.executions.cancelProject(project.id),
      { tmpDir: workspace.tmpDir, cleanup: workspace.cleanup, placeArtifact: workspace.placeArtifact },
    );
    this.executors.set(project.id, executor);
    this.scheduler.add(new ProjectLoop(
      project.id,
      this.config,
      this.client,
      executor,
      this.executions,
      async () => JSON.stringify(await jointPlan.paths(project.id)),
      {
        // The scratch workspace must not outlive the Project's active state: a
        // completed or stopped Project releases it on the next tick while
        // sibling Projects keep running. Re-activation re-establishes the
        // workspace before any new dispatch.
        onInactive: (status) => this.releaseProjectTarget(project.id, projectDir, status),
        onActivated: async () => {
          if (!this.backend) throw new Error("runtime not started");
          const workspace = await this.backend.ensureWorkspace(project.id, projectDir);
          executor.updateWorkspace(workspace);
        },
      },
    ));
    this.firstProjectId ??= project.id;
    return project;
  }

  async wait(projectId = this.firstProjectId): Promise<ProjectMeta & { deliverables: string[] }> {
    if (!this.client || !projectId) throw new Error("runtime not started");
    while (true) {
      const project = (await this.client.getProject(projectId)).project;
      if (project.status !== "active") {
        return { ...project, deliverables: this.executors.get(projectId)?.deliverables ?? [] };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, this.config.scheduler.intervalMs));
    }
  }

  async stop(): Promise<void> {
    if (this.leaseHeartbeat) clearInterval(this.leaseHeartbeat);
    this.leaseHeartbeat = undefined;
    this.scheduler?.stop();
    await this.executions.waitForEmpty();
    await this.releaseProjectLeases();
    await this.backend?.close();
    this.backend = undefined;
    if (this.taskSkills) cleanupTaskSkills(this.taskSkills);
    this.taskSkills = undefined;
    this.scheduler = undefined;
    this.client = undefined;
    this.projectsDir = undefined;
    this.firstProjectId = undefined;
    this.projectIds.clear();
    this.executors.clear();
  }

  /**
   * Releases one Project's execution workspace once it leaves active state.
   * Fire-and-forget from the ProjectLoop tick: `cleanupProject` is idempotent
   * and the audit event records the release with the reason status.
   */
  private releaseProjectTarget(projectId: string, projectDir: string, status: "completed" | "stopped"): void {
    writeProjectLog(projectDir, "execution_target_released", { projectId, mode: "local", status, action: "released" });
    void this.backend?.cleanupProject(projectId, status).catch((error: unknown) => {
      process.stderr.write(`[peak] failed to release execution target for ${projectId}: ${(error as Error).message}\n`);
    });
  }

  private createBackend(): ExecutionBackend {
    return new LocalBackend();
  }

  /**
   * Records a process-level crash (uncaughtException / unhandledRejection) in
   * every registered Project's logs/main.log so failures stay auditable even
   * when the server process dies. Synchronous append, safe during teardown.
   */
  logCrash(kind: "uncaughtException" | "unhandledRejection", error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    for (const executor of this.executors.values()) {
      executor.logEvent("process_crash", { kind, message, stack });
    }
  }

  /** Graph endpoint used by this Dispatch process. */
  get endpointUrl(): string { return this.options.graphUrl; }

  get graphClient(): GraphClient {
    if (!this.client) throw new Error("runtime not started");
    return this.client;
  }
}
