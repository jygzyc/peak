import { existsSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { initializeProjectsDirectory } from "../config/paths.js";
import { ApiError, localTimestamp, requireUuid } from "./api.js";
import { ArtifactStore } from "./artifact-store.js";
import { SqliteStore } from "./sqlite-store.js";
import { leafFacts, type CreateProjectInput, type FactRef, type ProjectGraph, type ProjectMeta, type ReopenInput } from "./types.js";

export interface ProjectStores { graph: SqliteStore; artifacts: ArtifactStore; dir: string }

export class ProjectStoreRegistry {
  private readonly stores = new Map<string, ProjectStores>();
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = initializeProjectsDirectory(baseDir);
    this.load();
  }

  create(input: CreateProjectInput): ProjectMeta {
    const id = randomUUID();
    const stores = this.open(id);
    return stores.graph.initialize(id, input);
  }

  reopen(projectId: string, input: ReopenInput): ProjectGraph {
    const stores = this.get(projectId);
    return stores.graph.reopen(input);
  }

  list(): ProjectMeta[] {
    return [...this.stores.values()].map((stores) => stores.graph.project()).filter((item): item is ProjectMeta => Boolean(item));
  }

  get(projectId: string): ProjectStores {
    requireUuid(projectId);
    const stores = this.stores.get(projectId);
    if (!stores) throw new ApiError(404, "project not found");
    return stores;
  }

  validateRefs(targetProjectId: string, refs: FactRef[], allowGoal = false): void {
    const target = this.get(targetProjectId).graph.project()!;
    if (refs.length === 0) throw new ApiError(400, "at least one FactRef is required");
    const unique = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.projectId}/${ref.factId}`;
      if (unique.has(key)) throw new ApiError(400, "duplicate FactRef");
      unique.add(key);
      if (!allowGoal && ref.factId === "goal") throw new ApiError(400, "goal cannot be a source");
      const source = this.get(ref.projectId).graph;
      const fact = source.fact(ref.factId);
      if (!fact) throw new ApiError(400, `fact not found: ${key}`);
      if (ref.description !== fact.description) throw new ApiError(400, `FactRef description mismatch: ${key}`);
      const sourceProject = source.project()!;
      if (ref.projectId !== targetProjectId && sourceProject.scope !== target.scope) {
        throw new ApiError(400, "FactRef crosses federation scope");
      }
    }
  }

  validateLeafRefs(targetProjectId: string, refs: FactRef[]): void {
    this.validateRefs(targetProjectId, refs);
    const leavesByProject = new Map<string, Set<string>>();
    for (const ref of refs) {
      let leaves = leavesByProject.get(ref.projectId);
      if (!leaves) {
        leaves = new Set(leafFacts(this.get(ref.projectId).graph.graph()).map((fact) => fact.id));
        leavesByProject.set(ref.projectId, leaves);
      }
      if (!leaves.has(ref.factId)) throw new ApiError(409, `FactRef is not a current leaf: ${ref.projectId}/${ref.factId}`);
    }
  }

  remove(projectId: string): void {
    const target = this.get(projectId);
    for (const [id, stores] of this.stores) {
      if (id !== projectId && stores.graph.externalReferences(projectId) > 0) {
        throw new ApiError(409, "project is referenced by another project");
      }
    }
    target.graph.close();
    this.stores.delete(projectId);
    rmSync(target.dir, { recursive: true, force: true });
  }

  gcArtifacts(maxAgeMs = 24 * 60 * 60 * 1000): void {
    const before = localTimestamp(new Date(Date.now() - maxAgeMs));
    for (const stores of this.stores.values()) {
      for (const sha256 of stores.graph.orphanArtifacts(before)) {
        stores.artifacts.remove(sha256);
        stores.graph.removeArtifact(sha256);
      }
    }
  }

  close(): void {
    for (const stores of this.stores.values()) stores.graph.close();
    this.stores.clear();
  }

  private load(): void {
    for (const name of readdirSync(this.baseDir)) {
      if (!isUuid(name) || !existsSync(join(this.baseDir, name, "analysis.db"))) continue;
      this.open(name);
    }
    for (const stores of this.stores.values()) {
      stores.graph.repairSourceDescriptions((projectId, factId) => this.stores.get(projectId)?.graph.fact(factId)?.description);
    }
  }

  private open(projectId: string): ProjectStores {
    const dir = this.projectDir(projectId);
    const stores = { graph: new SqliteStore(dir), artifacts: new ArtifactStore(dir), dir };
    this.stores.set(projectId, stores);
    return stores;
  }

  private projectDir(projectId: string): string {
    requireUuid(projectId);
    return resolve(this.baseDir, projectId);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
