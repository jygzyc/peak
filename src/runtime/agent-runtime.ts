import { projectDir as projectDirPath } from "../utils/paths.js";
import { initializePeakPaths, initializeProjectsDirectory, projectTmpDir } from "../utils/paths.js";
import { sourceTitle } from "../utils/helpers.js";
import { persistProjectId } from "../utils/task-config.js";
import type { InstalledSkill, ResolvedTaskConfig, TaskProjectConfig } from "../utils/types.js";
import { cleanupTaskSkills, initializeTaskSkills } from "../utils/task-skill-installer.js";
import { FederationBus } from "../graph/federation-bus.js";
import { GraphClient } from "../graph/graph-client.js";
import { GraphHttpServer, type HttpServerOptions } from "../graph/http-server.js";
import { ProjectStoreRegistry } from "../graph/project-store-registry.js";
import { type ProjectMeta } from "../graph/types.js";
import { serveDashboard } from "../ui/dashboard.js";
import { ExecutionRegistry } from "./execution-registry.js";
import { ProjectLoop } from "./project-loop.js";
import { RuntimeStatus, runtimeExtensions } from "./runtime-api.js";
import { RuntimeScheduler } from "./scheduler.js";
import { TaskExecutor } from "./task-executor.js";
import { WorkerPool } from "./worker-pool.js";

export interface RuntimeOptions extends HttpServerOptions {
  peakHome?: string;
  installSkills?: boolean;
  /**
   * External Graph mode: attach to a remote `peak serve` Graph API instead of
   * embedding ProjectStoreRegistry + GraphHttpServer. No UI root handler or
   * runtime apiExtensions are hosted in this mode.
   */
  graphUrl?: string;
  /** Local Projects root used to re-anchor relative Artifact paths (container: /peak/projects). */
  projectsRoot?: string;
  /** Attach-only mode: every selected Project must already have a persisted id; nothing is created. */
  attachOnly?: boolean;
}

export class AgentRuntime {
  private registry?: ProjectStoreRegistry;
  private server?: GraphHttpServer;
  private scheduler?: RuntimeScheduler;
  private client?: GraphClient;
  private projectsDir?: string;
  private firstProjectId?: string;
  private readonly projectIds = new Map<number, string>();
  private readonly executors = new Map<string, TaskExecutor>();
  private readonly federation = new FederationBus();
  private readonly executions = new ExecutionRegistry();
  private readonly runtimeStatus = new RuntimeStatus();
  private taskSkills?: InstalledSkill[];

  constructor(readonly config: ResolvedTaskConfig, readonly options: RuntimeOptions = {}) {}

  async start(projectSelector?: string, projectId?: string): Promise<ProjectMeta[]> {
    if (this.server) throw new Error("runtime already started");
    try {
      if (this.options.installSkills !== false) this.taskSkills = initializeTaskSkills(this.config);
      this.projectsDir = this.options.projectsRoot
        ? initializeProjectsDirectory(this.options.projectsRoot)
        : initializePeakPaths(this.options.peakHome).projectsDir;
      if (this.options.graphUrl) {
        // External Graph mode: the Graph API lives in a separate serve
        // process; this Runtime only schedules and runs Workers.
        this.client = new GraphClient(this.options.graphUrl, { projectsRoot: this.projectsDir });
      } else {
        this.registry = new ProjectStoreRegistry(this.projectsDir);
        this.server = new GraphHttpServer(this.registry, serveDashboard, runtimeExtensions(this.runtimeStatus, this.executions));
        await this.server.start({ ...this.options, maxArtifactBytes: this.config.phase.execute.maxArtifactBytes });
        this.client = new GraphClient(this.server.baseUrl, { projectsRoot: this.projectsDir });
      }
      this.scheduler = new RuntimeScheduler(this.config, this.executions);
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
      await this.seedProjectPaths(projects);
      this.runtimeStatus.start(this.config.scheduler.intervalMs);
      this.scheduler.start();
      return projects;
    } catch (error) {
      await this.stop();
      throw error;
    }
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
    if (!matched.id) persistProjectId(this.config, index, projectId);
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
    if (this.options.attachOnly) throw new Error(`attach-only mode requires a persisted Project id: ${configured.source}`);
    const project = await this.createProject(configured);
    persistProjectId(this.config, index, project.id);
    this.projectIds.set(index, project.id);
    return project;
  }

  private async createProject(configured: TaskProjectConfig): Promise<ProjectMeta> {
    if (!this.client) throw new Error("runtime not started");
    const project = await this.client.createProject({
      title: sourceTitle(configured.source),
      target: configured.source,
      goal: configured.goal,
    });
    return this.registerProject(project, { ...configured, id: project.id });
  }

  /**
   * Seeds every loaded Project's Federation state at startup: generates any
   * missing `path_abs_<factId>` descriptions and broadcasts the current
   * leaf references. Files are cached, so restarts cost no Worker
   * dispatches for already-analyzed Facts.
   */
  private async seedProjectPaths(projects: ProjectMeta[]): Promise<void> {
    for (const project of projects) {
      const executor = this.executors.get(project.id);
      if (!executor) throw new Error(`executor not registered: ${project.id}`);
      await executor.syncPaths(project.id);
    }
  }

  private registerProject(project: ProjectMeta, configured: TaskProjectConfig): ProjectMeta {
    if (!this.client || !this.projectsDir || !this.scheduler) throw new Error("runtime not started");
    const projectDir = projectDirPath(this.projectsDir, project.id);
    this.federation.register(project.id, projectDir, project.scope);
    const executor = new TaskExecutor(
      this.config,
      configured,
      this.client,
      new WorkerPool(this.config),
      this.federation,
      projectDir,
      () => this.executions.cancelProject(project.id),
      projectTmpDir(projectDir),
      (executionId, pid) => this.executions.setProcessId(executionId, pid),
    );
    this.executors.set(project.id, executor);
    this.scheduler.add(new ProjectLoop(
      project.id,
      this.config,
      this.client,
      executor,
      this.executions,
      () => this.federation.pendingPathsFor(project.id).length,
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
    this.scheduler?.stop();
    await this.executions.waitForEmpty();
    this.runtimeStatus.stop();
    if (this.taskSkills) cleanupTaskSkills(this.taskSkills);
    this.taskSkills = undefined;
    await this.server?.stop();
    this.registry?.close();
    this.scheduler = undefined;
    this.server = undefined;
    this.registry = undefined;
    this.client = undefined;
    this.projectsDir = undefined;
    this.firstProjectId = undefined;
    this.projectIds.clear();
    this.executors.clear();
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

  get webUrl(): string {
    if (!this.server) throw new Error("runtime not started");
    return this.server.baseUrl;
  }

  /** Embedded server URL, or the external Graph URL in external-graph mode (registration readiness signal). */
  get endpointUrl(): string | null {
    return this.server ? this.server.baseUrl : this.options.graphUrl ?? null;
  }

  get graphClient(): GraphClient {
    if (!this.client) throw new Error("runtime not started");
    return this.client;
  }
}
