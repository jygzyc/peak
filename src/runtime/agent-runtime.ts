import { join } from "node:path";
import { initializePeakPaths } from "../config/paths.js";
import { persistProjectId } from "../config/task-config.js";
import type { InstalledSkill, ResolvedTaskConfig, TaskProjectConfig } from "../config/types.js";
import { cleanupTaskSkills, initializeTaskSkills } from "../config/task-skill-installer.js";
import { FederationBus } from "../graph/federation-bus.js";
import { GraphClient } from "../graph/graph-client.js";
import { GraphHttpServer, type HttpServerOptions } from "../graph/http-server.js";
import { ProjectStoreRegistry } from "../graph/project-store-registry.js";
import { leafFacts, type ProjectMeta } from "../graph/types.js";
import { ProjectLoop } from "../project/project-loop.js";
import { ProjectManager } from "../project/project-manager.js";
import { serveDashboard } from "../ui/dashboard.js";
import { WorkerRuntime } from "../worker/worker-runtime.js";
import { runtimeExtensions } from "./runtime-api.js";
import { ExecutionRegistry } from "./execution-registry.js";
import { RuntimeStatus } from "./runtime-status.js";
import { RuntimeScheduler } from "./scheduler.js";
import { TaskExecutor } from "./task-executor.js";

export interface RuntimeOptions extends HttpServerOptions { peakHome?: string; installSkills?: boolean }

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
      this.projectsDir = initializePeakPaths(this.options.peakHome).projectsDir;
      this.registry = new ProjectStoreRegistry(this.projectsDir);
      this.server = new GraphHttpServer(this.registry, serveDashboard, runtimeExtensions(this.runtimeStatus, this.executions));
      await this.server.start({ ...this.options, maxArtifactBytes: this.config.phase.execute.maxArtifactBytes });
      this.client = new GraphClient(this.server.baseUrl, this.options.token);
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
      await this.seedExistingFacts(projects);
      this.runtimeStatus.start(this.config.scheduler.intervalMs);
      this.scheduler.start();
      return projects;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async addProject(projectSelector: string): Promise<ProjectMeta> {
    const index = this.projectIndex(projectSelector);
    return this.ensureProject(index);
  }

  async attachProject(projectId: string, projectSelector?: string): Promise<ProjectMeta> {
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
    const project = await this.createProject(configured);
    persistProjectId(this.config, index, project.id);
    this.projectIds.set(index, project.id);
    return project;
  }

  private async createProject(configured: TaskProjectConfig): Promise<ProjectMeta> {
    if (!this.client || !this.projectsDir) throw new Error("runtime not started");
    const manager = new ProjectManager(this.projectsDir, this.client);
    const project = await manager.create({
      title: sourceTitle(configured.source),
      target: configured.source,
      goal: configured.goal,
    });
    return this.registerProject(project, { ...configured, id: project.id });
  }

  private async seedExistingFacts(projects: ProjectMeta[]): Promise<void> {
    if (!this.client) throw new Error("runtime not started");
    for (const project of projects) {
      const graph = await this.client.getProject(project.id);
      for (const fact of leafFacts(graph)) {
        if (fact.id === "origin") continue;
        this.federation.publish({ projectId: project.id, factId: fact.id, description: fact.description });
      }
    }
  }

  private registerProject(project: ProjectMeta, configured: TaskProjectConfig): ProjectMeta {
    if (!this.client || !this.projectsDir || !this.scheduler) throw new Error("runtime not started");
    const projectDir = new ProjectManager(this.projectsDir, this.client).projectDir(project.id);
    this.federation.register(project.id, projectDir, project.scope);
    const executor = new TaskExecutor(
      this.config,
      configured,
      this.client,
      new WorkerRuntime(this.config),
      this.federation,
      projectDir,
      () => this.executions.cancelProject(project.id),
      join(projectDir, "pi-sessions"),
      (executionId, pid) => this.executions.setProcessId(executionId, pid),
    );
    this.executors.set(project.id, executor);
    this.scheduler.add(new ProjectLoop(
      project.id,
      this.config,
      this.client,
      executor,
      this.executions,
      () => this.federation.pendingFor(project.id).length,
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

  get webUrl(): string {
    if (!this.server) throw new Error("runtime not started");
    return this.server.baseUrl;
  }

  get graphClient(): GraphClient {
    if (!this.client) throw new Error("runtime not started");
    return this.client;
  }
}

/** Project title is only a short UI label; the complete immutable source lives in the origin Fact. */
function sourceTitle(source: string): string {
  if (Buffer.byteLength(source, "utf8") <= 1024) return source;
  let result = "";
  for (const character of source) {
    if (Buffer.byteLength(result + character, "utf8") > 1021) break;
    result += character;
  }
  return `${result}...`;
}
