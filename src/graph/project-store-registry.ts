import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { initializeProjectsDirectory } from "../utils/paths.js";
import { ApiError, localTimestamp, requireUuid, UUID_PATTERN } from "./api.js";
import { ArtifactStore } from "./artifact-store.js";
import {
  extractProjectArchive, packProjectArchive, parseProjectArchiveGraph, PROJECT_ARCHIVE_DATABASE, PROJECT_ARCHIVE_GRAPH,
  PROJECT_ARCHIVE_FORMAT, PROJECT_ARCHIVE_MANIFEST, sha256File, validateProjectArchiveGraph,
  type BoardProjectBlock, type ProjectArchiveManifest,
} from "./project-archive.js";
import { SqliteStore } from "./sqlite-store.js";
import { leafFacts, type ArtifactRef, type CreateProjectInput, type FactRef, type ProjectGraph, type ProjectMeta, type ReopenInput } from "./types.js";

export interface ProjectStores { graph: SqliteStore; artifacts: ArtifactStore; dir: string }
export interface ImportedProjectArchive { project: ProjectMeta; boardProject: BoardProjectBlock }

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

  async exportProjectArchive(projectId: string, outputPath: string): Promise<ProjectArchiveManifest> {
    const stores = this.get(projectId);
    if (stores.graph.project()?.status !== "completed") throw new ApiError(409, "only completed Projects can be archived");
    const destination = resolve(outputPath);
    if (pathEntryExists(destination)) throw new Error(`archive destination already exists: ${destination}`);
    mkdirSync(dirname(destination), { recursive: true });
    const staging = mkdtempSync(join(this.baseDir, ".export-"));
    const temporaryArchive = `${destination}.${randomUUID()}.tmp`;
    try {
      await stores.graph.backupTo(join(staging, PROJECT_ARCHIVE_DATABASE));
      const snapshot = new SqliteStore(staging);
      let graph: ProjectGraph;
      let artifacts: ArtifactRef[];
      try {
        graph = snapshot.graph();
        artifacts = snapshot.artifacts();
      } finally {
        snapshot.close();
      }
      if (graph.project.status !== "completed") throw new ApiError(409, "only completed Projects can be archived");
      validateProjectArchiveGraph(graph);
      const sourceDescription = graph.facts.find((fact) => fact.id === "origin")?.description;
      const goal = graph.facts.find((fact) => fact.id === "goal")?.description;
      if (!sourceDescription || !goal) throw new Error("completed Project has no Source or Goal Fact");
      const artifactsDir = join(staging, "artifacts");
      mkdirSync(artifactsDir);
      for (const artifact of artifacts) {
        if (artifact.path !== `artifacts/${artifact.sha256}`) throw new Error(`invalid persisted Artifact path: ${artifact.path}`);
        const source = stores.artifacts.path(artifact.sha256);
        const target = join(artifactsDir, artifact.sha256);
        try { linkSync(source, target); } catch { copyFileSync(source, target); }
        const stat = lstatSync(target);
        if (stat.size !== artifact.sizeBytes || await sha256File(target) !== artifact.sha256) {
          throw new Error(`persisted Artifact verification failed: ${artifact.sha256}`);
        }
      }
      const manifest: ProjectArchiveManifest = {
        format: PROJECT_ARCHIVE_FORMAT,
        exportedAt: localTimestamp(),
        project: { id: graph.project.id, source: sourceDescription, goal },
        graph: PROJECT_ARCHIVE_GRAPH,
        database: PROJECT_ARCHIVE_DATABASE,
        artifacts,
      };
      writeFileSync(join(staging, PROJECT_ARCHIVE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      writeFileSync(join(staging, PROJECT_ARCHIVE_GRAPH), `${JSON.stringify(graph, null, 2)}\n`, { flag: "wx" });
      await packProjectArchive(staging, temporaryArchive);
      try {
        linkSync(temporaryArchive, destination);
      } catch (error) {
        if (pathEntryExists(destination)) throw new Error(`archive destination already exists: ${destination}`);
        try { copyFileSync(temporaryArchive, destination, constants.COPYFILE_EXCL); }
        catch { throw error; }
      }
      return manifest;
    } finally {
      rmSync(temporaryArchive, { force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async importProjectArchive(archivePath: string): Promise<ImportedProjectArchive> {
    const archive = resolve(archivePath);
    const staging = mkdtempSync(join(this.baseDir, ".import-"));
    let imported: SqliteStore | undefined;
    let moved = false;
    try {
      const manifest = await extractProjectArchive(archive, staging);
      const projectId = manifest.project.id;
      const destination = this.projectDir(projectId);
      if (this.stores.has(projectId) || pathEntryExists(destination)) throw new ApiError(409, `Project already exists: ${projectId}`);
      const archivedGraph = parseProjectArchiveGraph(staging);
      imported = new SqliteStore(staging);
      imported.validatePortableArchive();
      const databaseGraph = imported.graph();
      validateProjectArchiveGraph(databaseGraph);
      const sourceDescription = databaseGraph.facts.find((fact) => fact.id === "origin")?.description;
      if (databaseGraph.project.id !== projectId || sourceDescription !== manifest.project.source) {
        throw new Error("Project archive metadata does not match its database");
      }
      const goal = databaseGraph.facts.find((fact) => fact.id === "goal")?.description;
      if (goal !== manifest.project.goal) throw new Error("Project archive Goal does not match its database");
      if (JSON.stringify(archivedGraph) !== JSON.stringify(databaseGraph)) throw new Error("Project archive Graph JSON does not match its database");
      const databaseArtifacts = imported.artifacts();
      if (!isDeepStrictEqual(databaseArtifacts, manifest.artifacts)) throw new Error("Project archive Artifact manifest does not match its database");
      for (const artifact of databaseArtifacts) {
        const path = join(staging, artifact.path);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.sizeBytes || await sha256File(path) !== artifact.sha256) {
          throw new Error(`Project archive Artifact verification failed: ${artifact.sha256}`);
        }
      }
      imported.close();
      imported = undefined;
      renameSync(staging, destination);
      moved = true;
      const stores = this.open(projectId);
      return { project: stores.graph.project()!, boardProject: manifest.project };
    } finally {
      imported?.close();
      if (!moved) rmSync(staging, { recursive: true, force: true });
    }
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

  /**
   * Server-boundary FactRef validation: refs must be non-empty, unique, local
   * to the target Project (cross-Project references are rejected; Federation
   * Paths are read-only and never Intent sources), point at existing Facts,
   * and carry the Fact's exact immutable description.
   */
  validateRefs(targetProjectId: string, refs: FactRef[], allowGoal = false): void {
    const target = this.get(targetProjectId).graph;
    if (refs.length === 0) throw new ApiError(400, "at least one FactRef is required");
    const unique = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.projectId}/${ref.id}`;
      if (ref.projectId !== targetProjectId) throw new ApiError(400, `FactRef must be a local Fact: ${key}`);
      if (unique.has(key)) throw new ApiError(400, "duplicate FactRef");
      unique.add(key);
      if (!allowGoal && ref.id === "goal") throw new ApiError(400, "goal cannot be a source");
      const fact = target.fact(ref.id);
      if (!fact) throw new ApiError(400, `fact not found: ${key}`);
      if (ref.description !== fact.description) throw new ApiError(400, `FactRef description mismatch: ${key}`);
    }
  }

  /** validateRefs plus the current-frontier rule: every source must still be a local leaf Fact. */
  validateLeafRefs(targetProjectId: string, refs: FactRef[]): void {
    this.validateRefs(targetProjectId, refs);
    const leaves = new Set(leafFacts(this.get(targetProjectId).graph.graph()).map((fact) => fact.id));
    for (const ref of refs) {
      if (!leaves.has(ref.id)) throw new ApiError(409, `FactRef is not a current leaf: ${ref.projectId}/${ref.id}`);
    }
  }

  remove(projectId: string): void {
    const target = this.get(projectId);
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
      if (!isUuid(name) || !existsSync(join(this.baseDir, name, "project.db"))) continue;
      this.open(name);
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
  return UUID_PATTERN.test(value);
}
function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
