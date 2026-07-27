import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedTaskConfig } from "../config/types.js";
import { initializeTaskSkills } from "../config/task-skill-installer.js";
import { FederationBus } from "../graph/federation-bus.js";
import { GraphClient } from "../graph/graph-client.js";
import { GraphHttpServer, type HttpServerOptions } from "../graph/http-server.js";
import { ProjectStoreRegistry } from "../graph/project-store-registry.js";
import type { ProjectMeta } from "../graph/types.js";
import { ProjectLoop } from "../project/project-loop.js";
import { ProjectManager } from "../project/project-manager.js";
import { WorkerResources, WorkerRuntime } from "../worker/worker-runtime.js";
import { ExecutionRegistry } from "./execution-registry.js";
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
  private readonly federation = new FederationBus();
  private readonly executions = new ExecutionRegistry();
  private readonly workerResources = new WorkerResources();

  constructor(readonly config: ResolvedTaskConfig, readonly options: RuntimeOptions = {}) {}

  async start(projectTitle?: string, projectId?: string): Promise<ProjectMeta> {
    if (this.server) throw new Error("runtime already started");
    const peakHome = resolve(this.options.peakHome ?? process.env.PEAK_HOME ?? join(homedir(), ".peak"));
    this.projectsDir = join(peakHome, "projects");
    mkdirSync(this.projectsDir, { recursive: true });
    this.registry = new ProjectStoreRegistry(this.projectsDir);
    this.server = new GraphHttpServer(this.registry);
    await this.server.start({ ...this.options, maxArtifactBytes: this.config.tasks.execute.maxArtifactBytes });
    this.client = new GraphClient(this.server.baseUrl, this.options.token);
    this.scheduler = new RuntimeScheduler(this.config.scheduler, this.executions);
    const project = projectId
      ? await this.attachProject(projectId, this.config)
      : await this.addProject(this.config, projectTitle);
    this.scheduler.start();
    return project;
  }

  async addProject(config: ResolvedTaskConfig, projectTitle?: string): Promise<ProjectMeta> {
    if (!this.client || !this.projectsDir) throw new Error("runtime not started");
    const manager = new ProjectManager(this.projectsDir, this.client);
    const project = await manager.create({
      title: projectTitle ?? config.task.name ?? "project",
      target: config.task.target,
      goal: config.task.goal,
      scope: config.federation?.scope,
    });
    return this.registerProject(project, config);
  }

  async attachProject(projectId: string, config: ResolvedTaskConfig): Promise<ProjectMeta> {
    if (!this.client) throw new Error("runtime not started");
    const graph = await this.client.getProject(projectId);
    if (graph.project.scope !== config.federation?.scope
      || graph.facts.find((fact) => fact.id === "origin")?.description !== config.task.target
      || graph.facts.find((fact) => fact.id === "goal")?.description !== config.task.goal) {
      throw new Error("task config does not match persisted Project");
    }
    return this.registerProject(graph.project, config);
  }

  private registerProject(project: ProjectMeta, config: ResolvedTaskConfig): ProjectMeta {
    if (!this.client || !this.projectsDir || !this.scheduler) throw new Error("runtime not started");
    if (this.options.installSkills !== false) initializeTaskSkills(config);
    const projectDir = new ProjectManager(this.projectsDir, this.client).projectDir(project.id);
    this.federation.register(project.id, projectDir, project.scope);
    const executor = new TaskExecutor(
      config,
      this.client,
      new WorkerRuntime(config, this.workerResources),
      this.federation,
      projectDir,
      () => this.executions.cancelProject(project.id),
    );
    this.scheduler.add(new ProjectLoop(
      project.id,
      config,
      this.client,
      executor,
      this.executions,
      () => this.federation.pendingFor(project.id).length,
    ));
    this.firstProjectId ??= project.id;
    return project;
  }

  async wait(projectId = this.firstProjectId): Promise<ProjectMeta> {
    if (!this.client || !projectId) throw new Error("runtime not started");
    while (true) {
      const project = (await this.client.getProject(projectId)).project;
      if (project.status !== "active") return project;
      await new Promise((resolveWait) => setTimeout(resolveWait, this.config.scheduler.intervalMs));
    }
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    this.workerResources.dispose();
    await this.server?.stop();
    this.registry?.close();
    this.scheduler = undefined;
    this.server = undefined;
    this.registry = undefined;
    this.client = undefined;
    this.projectsDir = undefined;
    this.firstProjectId = undefined;
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
