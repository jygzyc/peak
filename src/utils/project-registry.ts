import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { ApiError, requireUuid } from "../graph/api.js";
import type { ApiExtension } from "../graph/http-server.js";
import { bodyObject, empty, exact, json } from "./helpers.js";
import { isProcessAlive } from "./server-process.js";

export type TaskRegistrationMode = "start" | "resume";

/**
 * One Project-level ownership record in `<peakHome>/.projects.json`. A local
 * task Runtime carries `pid` (liveness by pid probing) and `webUrl` (its
 * embedded server URL, doubling as the background-launch readiness signal); a
 * container task carries `container` instead and is registered/deregistered
 * by its host-side launcher. All records of one task share `taskName`,
 * `runtimeId`, and `container`, so entries aggregate back into tasks.
 */
export interface ProjectRegistration {
  projectId: string;
  taskName: string;
  boardDir: string;
  mode: TaskRegistrationMode;
  runtimeId: string;
  pid: number | null;
  container: string | null;
  graphUrl: string | null;
  webUrl: string | null;
  startedAt: string;
}

interface ProjectsRegistryFile { version: 1; projects: ProjectRegistration[] }

/** Conflict raised when a Project UUID is already actively registered (the 409 semantic). */
export class ProjectRegistrationConflictError extends Error {
  constructor(readonly projectId: string) {
    super(`Project is already actively registered: ${projectId}`);
    this.name = "ProjectRegistrationConflictError";
  }
}

/** Path of the Project-level ownership registry owned by a Peak home. */
export function projectsRegistryPath(peakHome: string): string {
  return join(peakHome, ".projects.json");
}

/**
 * Registers the whole batch atomically: when any `projectId` is already
 * actively registered, a conflict error is raised and nothing is written.
 * This enforces "one active Project is never scheduled by two Runtimes".
 * Stale local entries (dead pid) are pruned before the conflict check.
 */
export function registerProjects(peakHome: string, entries: ProjectRegistration[]): void {
  const registry = readRegistry(peakHome);
  pruneStale(registry);
  for (const entry of entries) validateRegistration(entry);
  for (const entry of entries) {
    if (registry.projects.some((existing) => existing.projectId === entry.projectId)) {
      throw new ProjectRegistrationConflictError(entry.projectId);
    }
  }
  registry.projects.push(...entries);
  writeRegistry(peakHome, registry);
}

/** Lists current registrations, pruning and persisting stale local entries. */
export function listProjectRegistrations(peakHome: string): ProjectRegistration[] {
  const registry = readRegistry(peakHome);
  if (pruneStale(registry)) writeRegistry(peakHome, registry);
  return registry.projects;
}

/** Publishes the embedded server URL of every entry owned by one Runtime. */
export function updateRuntimeWebUrl(peakHome: string, runtimeId: string, webUrl: string): void {
  const registry = readRegistry(peakHome);
  const owned = registry.projects.filter((entry) => entry.runtimeId === runtimeId);
  if (owned.length === 0) throw new Error(`no registration for runtime: ${runtimeId}`);
  for (const entry of owned) entry.webUrl = webUrl;
  writeRegistry(peakHome, registry);
}

/** Removes every entry owned by one Runtime (normal Runtime shutdown). */
export function deregisterRuntime(peakHome: string, runtimeId: string): void {
  const registry = readRegistry(peakHome);
  const remaining = registry.projects.filter((entry) => entry.runtimeId !== runtimeId);
  if (remaining.length !== registry.projects.length) writeRegistry(peakHome, { version: 1, projects: remaining });
}

/** Removes one Project entry owned by one Runtime; false when no such record exists. */
export function deregisterProject(peakHome: string, projectId: string, runtimeId: string): boolean {
  const registry = readRegistry(peakHome);
  const remaining = registry.projects.filter((entry) => !(entry.projectId === projectId && entry.runtimeId === runtimeId));
  if (remaining.length === registry.projects.length) return false;
  writeRegistry(peakHome, { version: 1, projects: remaining });
  return true;
}

/** Drops local entries whose pid is no longer alive; true when anything changed. */
function pruneStale(registry: ProjectsRegistryFile): boolean {
  const remaining = registry.projects.filter((entry) => entry.pid === null || isProcessAlive(entry.pid));
  const changed = remaining.length !== registry.projects.length;
  if (changed) registry.projects = remaining;
  return changed;
}

function readRegistry(peakHome: string): ProjectsRegistryFile {
  try {
    const value = JSON.parse(readFileSync(projectsRegistryPath(peakHome), "utf8")) as Partial<ProjectsRegistryFile>;
    if (value.version !== 1 || !Array.isArray(value.projects)) return { version: 1, projects: [] };
    return { version: 1, projects: value.projects.filter(validRegistration) };
  } catch { return { version: 1, projects: [] }; }
}

function writeRegistry(peakHome: string, registry: ProjectsRegistryFile): void {
  const path = projectsRegistryPath(peakHome);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function validRegistration(value: unknown): value is ProjectRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.projectId === "string" && typeof entry.taskName === "string"
    && typeof entry.boardDir === "string" && (entry.mode === "start" || entry.mode === "resume")
    && typeof entry.runtimeId === "string"
    && (entry.pid === null || (typeof entry.pid === "number" && Number.isSafeInteger(entry.pid)))
    && (entry.container === null || typeof entry.container === "string")
    && (entry.graphUrl === null || typeof entry.graphUrl === "string")
    && (entry.webUrl === null || typeof entry.webUrl === "string")
    && typeof entry.startedAt === "string";
}

function validateRegistration(entry: ProjectRegistration): void {
  if (!validRegistration(entry)) throw new Error(`invalid Project registration: ${JSON.stringify(entry)}`);
}

/**
 * `POST/DELETE /api/projects/{id}/registration` — the Server-authoritative
 * Project ownership registry for external task Runtimes (external-graph and
 * container modes). Registering an already actively registered UUID returns
 * 409. Local embedded Runtimes write `.projects.json` directly instead of
 * using this endpoint, so CLI and HTTP paths share one conflict semantic.
 */
export function projectRegistrationExtension(peakHome: string): ApiExtension {
  return {
    matches(method: string, parts: string[]): boolean {
      return parts.length === 4 && parts[1] === "projects" && parts[3] === "registration"
        && (method === "POST" || method === "DELETE");
    },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const projectId = requireUuid(decodeURIComponent(url.pathname.split("/").filter(Boolean)[2] ?? ""));
      const body = await bodyObject(request);
      if (request.method === "POST") {
        exact(body, ["taskName", "boardDir", "mode", "runtimeId", "pid", "container", "graphUrl", "webUrl"],
          ["pid", "container", "graphUrl", "webUrl"]);
        const entry: ProjectRegistration = {
          projectId,
          taskName: requireString(body.taskName, "taskName"),
          boardDir: requireString(body.boardDir, "boardDir"),
          mode: requireMode(body.mode),
          runtimeId: requireRuntimeId(body.runtimeId),
          pid: optionalPid(body.pid),
          container: nullableString(body.container, "container"),
          graphUrl: nullableString(body.graphUrl, "graphUrl"),
          webUrl: nullableString(body.webUrl, "webUrl"),
          startedAt: new Date().toISOString(),
        };
        try {
          registerProjects(peakHome, [entry]);
        } catch (error) {
          if (error instanceof ProjectRegistrationConflictError) throw new ApiError(409, error.message);
          throw error;
        }
        json(response, entry, 201);
        return true;
      }
      exact(body, ["runtimeId"]);
      const removed = deregisterProject(peakHome, projectId, requireRuntimeId(body.runtimeId));
      if (!removed) throw new ApiError(404, "registration not found");
      empty(response, 204);
      return true;
    },
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ApiError(400, `${label} must be a non-empty string`);
  return value;
}

function requireMode(value: unknown): TaskRegistrationMode {
  if (value !== "start" && value !== "resume") throw new ApiError(400, "mode must be start or resume");
  return value;
}

function requireRuntimeId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}$/.test(value)) throw new ApiError(400, "runtimeId must be 8 lowercase hex characters");
  return value;
}

function optionalPid(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ApiError(400, "pid must be a positive integer");
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, label);
}
