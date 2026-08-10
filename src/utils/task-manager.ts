import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { ApiError } from "../graph/api.js";
import type { ApiExtension } from "../graph/http-server.js";
import type { ProjectStoreRegistry } from "../graph/project-store-registry.js";
import { DockerImageUnavailableError, dockerContainerState, dockerStop, launchDockerTask } from "./docker.js";
import { bodyObject, exact, json } from "./helpers.js";
import { deregisterRuntime, listProjectRegistrations } from "./project-registry.js";
import { isProcessAlive, terminateProcess } from "./server-process.js";
import { loadTaskConfig } from "./task-config.js";

export interface TaskRuntimeInfo {
  mode: string;
  pid: number | null;
  container: string | null;
  startedAt: string;
}

export interface TaskSummary {
  name: string;
  boardDir: string;
  status: "running" | "stopped";
  runtime: TaskRuntimeInfo | null;
  projects: Array<{ id: string; title: string; status: string }>;
}

export interface TaskManagerContext {
  peakHome: string;
  projectsDir: string;
  registry: ProjectStoreRegistry;
  /** Absolute path of the Peak CLI entry spawned for local task starts. */
  cliEntry: string;
  /** Loopback URL of this serve process, handed to spawned task Runtimes. */
  serveUrl: string;
  version: string;
}

export class TaskManagerError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "TaskManagerError"; }
}

/** Root of the Server-managed Board directories (`<root>/tasks/<taskName>/`). */
export function tasksDir(peakHome: string): string {
  return join(peakHome, "tasks");
}

/** Task names become directory names and docker name inputs; keep them filesystem-safe. */
export function requireTaskName(name: unknown): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new TaskManagerError(400, "invalid task name");
  }
  return name;
}

/**
 * Lists tasks from the two sources of truth: the `<root>/tasks/` directory
 * scan (Board definitions) and the `.projects.json` registry (runtime state).
 * No new persistence is introduced.
 */
export function listTasks(context: Pick<TaskManagerContext, "peakHome" | "registry">): TaskSummary[] {
  const registrations = listProjectRegistrations(context.peakHome);
  const metas = new Map(context.registry.list().map((project) => [project.id, project]));
  const names = new Set<string>();
  const root = tasksDir(context.peakHome);
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, "task.json"))) names.add(entry.name);
    }
  }
  for (const entry of registrations) names.add(entry.taskName);
  return [...names].sort().map((name) => {
    const entries = registrations.filter((entry) => entry.taskName === name);
    const running = entries.filter((entry) => (entry.pid !== null && isProcessAlive(entry.pid)) || entry.container !== null);
    const first = running[0] ?? entries[0];
    const projectIds = taskProjectIds(context.peakHome, name);
    for (const entry of entries) if (!projectIds.includes(entry.projectId)) projectIds.push(entry.projectId);
    return {
      name,
      boardDir: first?.boardDir ?? join(root, name),
      status: running.length > 0 ? "running" : "stopped",
      runtime: first
        ? { mode: first.mode, pid: first.pid, container: first.container, startedAt: first.startedAt }
        : null,
      projects: projectIds.map((id) => ({
        id,
        title: metas.get(id)?.title ?? "(not created)",
        status: metas.get(id)?.status ?? "unknown",
      })),
    } satisfies TaskSummary;
  });
}

export interface CreateTaskInput {
  name: string;
  projects: Array<{ source: string; goal: string }>;
  workers: Array<Record<string, unknown>>;
  skills?: string[];
}

/**
 * Scaffolds `<root>/tasks/<name>/task.json` and validates it through the
 * strict `loadTaskConfig()` before it is accepted; invalid input removes the
 * scaffold and reports the schema error.
 */
export function createTask(peakHome: string, input: CreateTaskInput): TaskSummary {
  const name = requireTaskName(input.name);
  const dir = join(tasksDir(peakHome), name);
  if (existsSync(dir)) throw new TaskManagerError(409, `task already exists: ${name}`);
  if (!Array.isArray(input.projects) || input.projects.length === 0) throw new TaskManagerError(400, "projects must be a non-empty array");
  if (!Array.isArray(input.workers) || input.workers.length === 0) throw new TaskManagerError(400, "workers must be a non-empty array");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "task.json"), `${JSON.stringify({
      board: {
        name,
        ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
        projects: input.projects.map((project) => ({ id: "", source: project.source, goal: project.goal })),
      },
      workers: input.workers,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    loadTaskConfig(dir); // strict schema validation; throws on any violation
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    if (error instanceof TaskManagerError) throw error;
    throw new TaskManagerError(400, (error as Error).message);
  }
  return { name, boardDir: dir, status: "stopped", runtime: null, projects: [] };
}

/**
 * Starts a managed task. `local` spawns `peak start --foreground --graph-url`
 * attached to this serve; `docker` reuses the `peak start --docker` two-phase
 * launch. An already running task is a 409 (registry conflict semantic).
 */
export async function startTask(context: TaskManagerContext, name: string, mode: "local" | "docker"): Promise<void> {
  requireTaskName(name);
  const dir = join(tasksDir(context.peakHome), name);
  if (!existsSync(join(dir, "task.json"))) throw new TaskManagerError(404, `task not found: ${name}`);
  const running = listProjectRegistrations(context.peakHome)
    .filter((entry) => entry.taskName === name)
    .filter((entry) => (entry.pid !== null && isProcessAlive(entry.pid)) || (entry.container !== null && dockerContainerState(entry.container) === "running"));
  if (running.length > 0) throw new TaskManagerError(409, `task is already running: ${name}`);
  if (mode === "docker") {
    try {
      await launchDockerTask(dir, {
        peakHome: context.peakHome,
        graphUrl: context.serveUrl,
        version: context.version,
      });
    } catch (error) {
      // The API caller explicitly chose docker; an unavailable image is a
      // readable 409-style conflict, not a silent local fallback.
      if (error instanceof DockerImageUnavailableError) throw new TaskManagerError(400, error.message);
      throw error;
    }
    return;
  }
  const logPath = join(dir, "task.log");
  const log = openSync(logPath, "a");
  const args = [
    context.cliEntry, "start", dir, "--foreground",
    "--graph-url", context.serveUrl,
    "--projects-root", context.projectsDir,
    "--peak-home", context.peakHome,
  ];
  const child = spawn(process.execPath, args, { cwd: dir, detached: true, windowsHide: true, env: process.env, stdio: ["ignore", log, log] });
  closeSync(log);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new TaskManagerError(500, `task process exited with code ${child.exitCode}; see ${logPath}`);
    }
    const registered = listProjectRegistrations(context.peakHome).some((entry) => entry.pid === child.pid);
    if (registered) {
      child.unref();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(child.pid!, "SIGTERM"); } catch { /* best effort */ }
  throw new TaskManagerError(500, `task process did not register within 15 seconds; see ${logPath}`);
}

/** Stops a managed task: local processes are SIGTERMed, containers docker-stopped; leftovers deregister. */
export async function stopTask(context: Pick<TaskManagerContext, "peakHome">, name: string): Promise<void> {
  requireTaskName(name);
  const entries = listProjectRegistrations(context.peakHome).filter((entry) => entry.taskName === name);
  if (entries.length === 0) return;
  for (const container of new Set(entries.map((entry) => entry.container).filter((item): item is string => item !== null))) {
    if (dockerContainerState(container) === "running") dockerStop(container);
  }
  for (const pid of new Set(entries.map((entry) => entry.pid).filter((item): item is number => item !== null))) {
    if (isProcessAlive(pid)) await terminateProcess(pid);
  }
  for (const runtimeId of new Set(entries.map((entry) => entry.runtimeId))) deregisterRuntime(context.peakHome, runtimeId);
}

/**
 * Deletes a managed task: stops it, removes the Board directory. Project UUID
 * data is preserved by default (attachable elsewhere); `purge` additionally
 * removes every Project shard through the registry (which closes the stores
 * first). Purge is irreversible.
 */
export async function deleteTask(context: TaskManagerContext, name: string, purge: boolean): Promise<void> {
  requireTaskName(name);
  const dir = join(tasksDir(context.peakHome), name);
  const projectIds = taskProjectIds(context.peakHome, name);
  for (const entry of listProjectRegistrations(context.peakHome)) {
    if (entry.taskName === name && !projectIds.includes(entry.projectId)) projectIds.push(entry.projectId);
  }
  await stopTask(context, name);
  if (purge) {
    for (const projectId of projectIds) {
      try { context.registry.remove(projectId); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Project ids configured in a managed task's task.json (empty when unreadable). */
function taskProjectIds(peakHome: string, name: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(tasksDir(peakHome), name, "task.json"), "utf8")) as {
      board?: { projects?: Array<{ id?: string }> };
    };
    return (parsed.board?.projects ?? []).map((project) => project.id ?? "").filter((id) => id.length > 0);
  } catch { return []; }
}

/**
 * Task lifecycle control plane (plan §7): the Server manages Board
 * directories under `<root>/tasks/` and starts/stops local or container task
 * Runtimes. It never writes Graph state (Graph immutability is unaffected).
 *
 * Routes:
 *   GET    /api/tasks                 list tasks (definitions + runtime state)
 *   POST   /api/tasks                 scaffold + strictly validate a new Board
 *   POST   /api/tasks/{name}/start    body {runtime: "local"|"docker"}; 409 when running
 *   POST   /api/tasks/{name}/stop     stop processes/containers and deregister
 *   DELETE /api/tasks/{name}          stop + delete Board dir; ?purge=true also removes Project shards
 */
export function taskManagerExtension(context: TaskManagerContext): ApiExtension {
  return {
    matches(method: string, parts: string[]): boolean {
      if (parts[1] !== "tasks") return false;
      if (parts.length === 2) return method === "GET" || method === "POST";
      if (parts.length === 3) return method === "DELETE";
      return parts.length === 4 && method === "POST" && (parts[3] === "start" || parts[3] === "stop");
    },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (parts.length === 2 && request.method === "GET") {
          json(response, { tasks: listTasks(context) });
          return true;
        }
        if (parts.length === 2 && request.method === "POST") {
          const body = await bodyObject(request);
          exact(body, ["name", "projects", "workers", "skills"], ["skills"]);
          const input: CreateTaskInput = {
            name: body.name as string,
            projects: projects(body.projects),
            workers: workers(body.workers),
            skills: optionalStrings(body.skills),
          };
          json(response, createTask(context.peakHome, input), 201);
          return true;
        }
        const name = parts[2]!;
        if (parts.length === 4 && parts[3] === "start") {
          const body = await bodyObject(request);
          exact(body, ["runtime"]);
          if (body.runtime !== "local" && body.runtime !== "docker") throw new ApiError(400, "runtime must be local or docker");
          await startTask(context, name, body.runtime);
          json(response, { name, status: "running", runtime: body.runtime });
          return true;
        }
        if (parts.length === 4 && parts[3] === "stop") {
          await stopTask(context, name);
          json(response, { name, status: "stopped" });
          return true;
        }
        // DELETE /api/tasks/{name}: purge requires the explicit query flag;
        // the UI double-confirms before sending it.
        const purge = url.searchParams.get("purge") === "true";
        await deleteTask(context, name, purge);
        json(response, { name, deleted: true, purged: purge });
        return true;
      } catch (error) {
        if (error instanceof TaskManagerError) throw new ApiError(error.status, error.message);
        throw error;
      }
    },
  };
}

function projects(value: unknown): CreateTaskInput["projects"] {
  if (!Array.isArray(value)) throw new ApiError(400, "projects must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError(400, "invalid project entry");
    const entry = item as Record<string, unknown>;
    exact(entry, ["source", "goal"]);
    return { source: requireString(entry.source, "project.source"), goal: requireString(entry.goal, "project.goal") };
  });
}

function workers(value: unknown): CreateTaskInput["workers"] {
  if (!Array.isArray(value)) throw new ApiError(400, "workers must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError(400, "invalid worker entry");
    return item as Record<string, unknown>;
  });
}

function optionalStrings(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ApiError(400, "skills must be a string array");
  return value as string[];
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ApiError(400, `${label} must be a non-empty string`);
  return value;
}
