import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { ApiError } from "./helpers.js";
import { requireUuid } from "../graph/api.js";
import type { ApiExtension } from "../graph/http-server.js";
import { bodyObject, empty, exact, json } from "./helpers.js";

export type TaskRegistrationMode = "start" | "resume";

export const PROJECT_LEASE_TTL_MS = 15_000;
export const PROJECT_LEASE_HEARTBEAT_MS = 5_000;

/** One Server-authoritative, TTL-bound Project scheduling lease. */
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
  heartbeatAt: string;
  expiresAt: string;
}

export type ProjectRegistrationEntry = Omit<ProjectRegistration, "heartbeatAt" | "expiresAt">;
export interface TaskFederationMount { taskName: string; projectIds: string[] }
interface ProjectsRegistryFile {
  version: 3;
  projects: ProjectRegistration[];
  federations: TaskFederationMount[];
}

export class ProjectRegistrationConflictError extends Error {
  constructor(readonly projectId: string) {
    super(`Project is already actively leased: ${projectId}`);
    this.name = "ProjectRegistrationConflictError";
  }
}

export function projectsRegistryPath(peakHome: string): string {
  return join(peakHome, ".projects.json");
}

/** Atomically rewrites one small Server registry file after checking all leases. */
export function registerProjects(
  peakHome: string,
  entries: ProjectRegistrationEntry[],
  federationProjectIds: string[],
  ttlMs = PROJECT_LEASE_TTL_MS,
): ProjectRegistration[] {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Project lease TTL must be a positive integer");
  for (const entry of entries) validateRegistration(entry);
  const mountedProjectIds = requireProjectIds(federationProjectIds);
  const mountedProjectIdSet = new Set(mountedProjectIds);
  for (const entry of entries) {
    if (!mountedProjectIdSet.has(entry.projectId)) throw new ApiError(400, `Project is not in the Task Federation: ${entry.projectId}`);
  }
  const registry = readRegistry(peakHome);
  pruneExpired(registry);
  for (const taskName of new Set(entries.map((entry) => entry.taskName))) {
    mountTaskFederation(registry, taskName, mountedProjectIds);
  }
  for (const entry of entries) {
    if (registry.projects.some((existing) => existing.projectId === entry.projectId)) {
      throw new ProjectRegistrationConflictError(entry.projectId);
    }
  }
  const now = Date.now();
  const leases = entries.map((entry) => ({
    ...entry,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  }));
  registry.projects.push(...leases);
  writeRegistry(peakHome, registry);
  return leases;
}

/** Returns live leases; expired rows are removed on the next Server mutation. */
export function listProjectRegistrations(peakHome: string): ProjectRegistration[] {
  const registry = readRegistry(peakHome);
  pruneExpired(registry);
  return registry.projects;
}

/** Returns the immutable Project membership mounted for one Task. */
export function taskFederationProjectIds(peakHome: string, taskName: string): string[] | undefined {
  const mount = readRegistry(peakHome).federations.find((entry) => entry.taskName === taskName);
  return mount ? [...mount.projectIds] : undefined;
}

/** Removes a Task mount when the Task definition itself is deleted. */
export function removeTaskFederation(peakHome: string, taskName: string): void {
  const registry = readRegistry(peakHome);
  const federations = registry.federations.filter((entry) => entry.taskName !== taskName);
  if (federations.length !== registry.federations.length) writeRegistry(peakHome, { ...registry, federations });
}

export function heartbeatRuntime(peakHome: string, runtimeId: string, ttlMs = PROJECT_LEASE_TTL_MS): boolean {
  requireValidRuntimeId(runtimeId);
  const registry = readRegistry(peakHome);
  pruneExpired(registry);
  const owned = registry.projects.filter((entry) => entry.runtimeId === runtimeId);
  if (owned.length === 0) return false;
  renew(owned, ttlMs);
  writeRegistry(peakHome, registry);
  return true;
}

export function heartbeatProject(
  peakHome: string,
  projectId: string,
  runtimeId: string,
  ttlMs = PROJECT_LEASE_TTL_MS,
): ProjectRegistration | undefined {
  const registry = readRegistry(peakHome);
  pruneExpired(registry);
  const lease = registry.projects.find((entry) => entry.projectId === projectId && entry.runtimeId === runtimeId);
  if (!lease) return undefined;
  renew([lease], ttlMs);
  writeRegistry(peakHome, registry);
  return lease;
}

export function updateRuntimeWebUrl(peakHome: string, runtimeId: string, webUrl: string): void {
  const registry = readRegistry(peakHome);
  pruneExpired(registry);
  const owned = registry.projects.filter((entry) => entry.runtimeId === runtimeId);
  if (owned.length === 0) throw new Error(`no live Project lease for runtime: ${runtimeId}`);
  for (const entry of owned) entry.webUrl = webUrl;
  writeRegistry(peakHome, registry);
}

export function deregisterRuntime(peakHome: string, runtimeId: string): void {
  const registry = readRegistry(peakHome);
  const remaining = registry.projects.filter((entry) => entry.runtimeId !== runtimeId);
  if (remaining.length !== registry.projects.length) writeRegistry(peakHome, { ...registry, projects: remaining });
}

export function deregisterProject(peakHome: string, projectId: string, runtimeId: string): boolean {
  const registry = readRegistry(peakHome);
  const remaining = registry.projects.filter((entry) => !(entry.projectId === projectId && entry.runtimeId === runtimeId));
  if (remaining.length === registry.projects.length) return false;
  writeRegistry(peakHome, { ...registry, projects: remaining });
  return true;
}

/** Project lease HTTP API: acquire, heartbeat, and owner-checked release. */
export function projectRegistrationExtension(peakHome: string, ttlMs = PROJECT_LEASE_TTL_MS): ApiExtension {
  return {
    matches(method: string, parts: string[]): boolean {
      return parts.length === 4 && parts[1] === "projects" && parts[3] === "registration"
        && (method === "POST" || method === "PUT" || method === "DELETE");
    },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const projectId = requireUuid(decodeURIComponent(url.pathname.split("/").filter(Boolean)[2] ?? ""));
      const body = await bodyObject(request);
      if (request.method === "POST") {
        exact(body, ["taskName", "projectIds", "boardDir", "mode", "runtimeId", "pid", "container", "graphUrl", "webUrl"],
          ["pid", "container", "graphUrl", "webUrl"]);
        const entry: ProjectRegistrationEntry = {
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
        const projectIds = requireProjectIds(body.projectIds);
        try {
          json(response, registerProjects(peakHome, [entry], projectIds, ttlMs)[0], 201);
        } catch (error) {
          if (error instanceof ProjectRegistrationConflictError) throw new ApiError(409, error.message);
          throw error;
        }
        return true;
      }
      exact(body, ["runtimeId"]);
      const runtimeId = requireRuntimeId(body.runtimeId);
      if (request.method === "PUT") {
        const lease = heartbeatProject(peakHome, projectId, runtimeId, ttlMs);
        if (!lease) throw new ApiError(409, `Project lease lost: ${projectId}`);
        json(response, lease);
        return true;
      }
      if (!deregisterProject(peakHome, projectId, runtimeId)) throw new ApiError(404, "Project lease not found");
      empty(response, 204);
      return true;
    },
  };
}

function readRegistry(peakHome: string): ProjectsRegistryFile {
  try {
    const value = JSON.parse(readFileSync(projectsRegistryPath(peakHome), "utf8")) as Partial<ProjectsRegistryFile>;
    if (value.version !== 3 || !Array.isArray(value.projects) || !Array.isArray(value.federations)) return emptyRegistry();
    return {
      version: 3,
      projects: value.projects.filter(validRegistration),
      federations: value.federations.filter(validFederationMount),
    };
  } catch { return emptyRegistry(); }
}

function writeRegistry(peakHome: string, registry: ProjectsRegistryFile): void {
  const path = projectsRegistryPath(peakHome);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function pruneExpired(registry: ProjectsRegistryFile): void {
  const now = Date.now();
  registry.projects = registry.projects.filter((entry) => Date.parse(entry.expiresAt) > now);
}

function renew(entries: ProjectRegistration[], ttlMs: number): void {
  const now = Date.now();
  const heartbeatAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  for (const entry of entries) {
    entry.heartbeatAt = heartbeatAt;
    entry.expiresAt = expiresAt;
  }
}

/** Pins Task membership once and rejects every later attempt to redefine it. */
function mountTaskFederation(registry: ProjectsRegistryFile, taskName: string, projectIds: string[]): void {
  const normalized = requireProjectIds(projectIds).sort();
  const existing = registry.federations.find((entry) => entry.taskName === taskName);
  if (!existing) {
    registry.federations.push({ taskName, projectIds: normalized });
    return;
  }
  if (existing.projectIds.length !== normalized.length
    || existing.projectIds.some((projectId, index) => projectId !== normalized[index])) {
    throw new ApiError(409, `Task Federation membership is already fixed: ${taskName}`);
  }
}

function emptyRegistry(): ProjectsRegistryFile { return { version: 3, projects: [], federations: [] }; }

function validFederationMount(value: unknown): value is TaskFederationMount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.taskName === "string" && Array.isArray(entry.projectIds)
    && entry.projectIds.length > 0 && entry.projectIds.every((id) => typeof id === "string");
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
    && typeof entry.startedAt === "string" && typeof entry.heartbeatAt === "string" && typeof entry.expiresAt === "string";
}

function validateRegistration(entry: ProjectRegistrationEntry): void {
  requireUuid(entry.projectId);
  requireString(entry.taskName, "taskName");
  requireString(entry.boardDir, "boardDir");
  requireMode(entry.mode);
  requireValidRuntimeId(entry.runtimeId);
  optionalPid(entry.pid);
  nullableString(entry.container, "container");
  nullableString(entry.graphUrl, "graphUrl");
  nullableString(entry.webUrl, "webUrl");
  if (!Number.isFinite(Date.parse(entry.startedAt))) throw new Error("startedAt must be an ISO timestamp");
}

function requireProjectIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError(400, "projectIds must be a non-empty array");
  const projectIds = value.map((id) => requireUuid(id));
  if (new Set(projectIds).size !== projectIds.length) throw new ApiError(400, "projectIds contains duplicates");
  return projectIds;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ApiError(400, `${label} must be a non-empty string`);
  return value;
}
function requireMode(value: unknown): TaskRegistrationMode {
  if (value !== "start" && value !== "resume") throw new ApiError(400, "mode must be start or resume");
  return value;
}
function requireValidRuntimeId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}$/.test(value)) throw new ApiError(400, "runtimeId must be 8 lowercase hex characters");
}
function requireRuntimeId(value: unknown): string { requireValidRuntimeId(value); return value; }
function optionalPid(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ApiError(400, "pid must be a positive integer");
  return value;
}
function nullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, label);
}
