import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { create as createTar, extract as extractTar, list as listTar } from "tar";
import {
  requireCustomProfileDigest, requireDescription, requireFactDescription, requireIntentDescription, requireShortDescription, requireUuid,
} from "./api.js";
import type { ArtifactRef, FactRef, ProjectGraph } from "./types.js";

export const PROJECT_ARCHIVE_FORMAT = "peak-project-archive";
export const PROJECT_ARCHIVE_GRAPH = "graph.json";
export const PROJECT_ARCHIVE_DATABASE = "analysis.db";
export const PROJECT_ARCHIVE_MANIFEST = "manifest.json";

export interface BoardProjectBlock { id: string; source: string; goal: string }

export interface ProjectArchiveManifest {
  format: typeof PROJECT_ARCHIVE_FORMAT;
  exportedAt: string;
  project: BoardProjectBlock;
  graph: typeof PROJECT_ARCHIVE_GRAPH;
  database: typeof PROJECT_ARCHIVE_DATABASE;
  artifacts: ArtifactRef[];
}

/** Packs an already validated staging directory into one portable gzip tarball. */
export async function packProjectArchive(stagingDir: string, destination: string): Promise<void> {
  await createTar({
    cwd: stagingDir,
    file: destination,
    gzip: true,
    noMtime: true,
    portable: true,
    strict: true,
  }, [PROJECT_ARCHIVE_MANIFEST, PROJECT_ARCHIVE_GRAPH, PROJECT_ARCHIVE_DATABASE, "artifacts"]);
}

/** Safely extracts only the canonical Project archive layout. */
export async function extractProjectArchive(archivePath: string, stagingDir: string): Promise<ProjectArchiveManifest> {
  if (!existsSync(archivePath) || !regularFile(archivePath)) throw new Error(`Project archive not found: ${archivePath}`);
  const entries = new Map<string, { type: string; size: number }>();
  await listTar({
    file: archivePath,
    strict: true,
    maxDepth: 2,
    onentry: (entry) => {
      const path = entry.path;
      if (!archiveEntry(path, entry.type)) throw new Error(`invalid Project archive entry: ${path}`);
      if (entries.has(path)) throw new Error(`duplicate Project archive entry: ${path}`);
      entries.set(path, { type: entry.type, size: entry.size });
    },
  });
  for (const required of [PROJECT_ARCHIVE_MANIFEST, PROJECT_ARCHIVE_GRAPH, PROJECT_ARCHIVE_DATABASE]) {
    if (entries.get(required)?.type !== "File") throw new Error(`Project archive is missing ${required}`);
  }
  await extractTar({
    cwd: stagingDir,
    file: archivePath,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    maxDepth: 2,
    unlink: true,
  });
  const manifest = parseProjectArchiveManifest(readJson(join(stagingDir, PROJECT_ARCHIVE_MANIFEST), "manifest"));
  validateExtractedTree(stagingDir, manifest);
  return manifest;
}

export function parseProjectArchiveGraph(stagingDir: string): ProjectGraph {
  const value = readJson(join(stagingDir, PROJECT_ARCHIVE_GRAPH), "Graph");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Project archive Graph");
  return value as ProjectGraph;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Revalidates persisted values so an imported database cannot bypass the public Graph protocol. */
export function validateProjectArchiveGraph(graph: ProjectGraph): void {
  requireUuid(graph.project.id);
  requireShortDescription(graph.project.title, "project.title");
  if (graph.project.status !== "completed") throw new Error("Project archive is not completed");
  if (graph.project.scope !== undefined) requireDescription(graph.project.scope, "project.scope");
  timestamp(graph.project.createdAt, "project.createdAt");
  const facts = new Map(graph.facts.map((fact) => [fact.id, fact]));
  if (facts.size !== graph.facts.length || !facts.has("origin") || !facts.has("goal")) throw new Error("Project archive has an invalid Fact set");
  for (const fact of graph.facts) {
    if (fact.id !== "origin" && fact.id !== "goal" && !/^f\d{3,}$/.test(fact.id)) throw new Error(`invalid Fact id: ${fact.id}`);
    if (fact.id === "origin" || fact.id === "goal") {
      requireDescription(fact.description, `Fact ${fact.id}`);
      if (fact.artifact !== null) throw new Error(`reserved Fact ${fact.id} cannot have an Artifact`);
    } else {
      requireFactDescription(fact.description, `Fact ${fact.id}`);
      if (fact.artifact) validateArtifact(fact.artifact);
    }
    timestamp(fact.createdAt, `Fact ${fact.id}.createdAt`);
  }
  const intentIds = new Set<string>();
  let completions = 0;
  for (const intent of graph.intents) {
    if (!/^i\d{3,}$/.test(intent.id) || intentIds.has(intent.id)) throw new Error(`invalid or duplicate Intent id: ${intent.id}`);
    intentIds.add(intent.id);
    if (!Array.isArray(intent.from) || intent.from.length === 0) throw new Error(`Intent ${intent.id} has no source`);
    const sourceKeys = new Set<string>();
    for (const ref of intent.from) {
      validateFactRef(ref, false);
      const key = `${ref.projectId}/${ref.factId}`;
      if (sourceKeys.has(key)) throw new Error(`Intent ${intent.id} has duplicate sources`);
      sourceKeys.add(key);
      if (ref.projectId === graph.project.id && facts.get(ref.factId)?.description !== ref.description) {
        throw new Error(`Intent ${intent.id} has a non-canonical local FactRef`);
      }
    }
    if (intent.to) {
      validateFactRef(intent.to, true);
      if (intent.to.projectId !== graph.project.id || facts.get(intent.to.factId)?.description !== intent.to.description) {
        throw new Error(`Intent ${intent.id} has an invalid target FactRef`);
      }
      if (intent.to.factId === "goal") completions += 1;
    }
    if ((intent.customProfile === null) !== (intent.customProfileDigest === null)) throw new Error(`Intent ${intent.id} has incomplete custom profile metadata`);
    if (intent.customProfile !== null) requireShortDescription(intent.customProfile, "customProfile");
    if (intent.customProfileDigest !== null) requireCustomProfileDigest(intent.customProfileDigest);
    if (!Array.isArray(intent.hintIds) || new Set(intent.hintIds).size !== intent.hintIds.length) throw new Error(`Intent ${intent.id} has invalid Hint ids`);
    for (const hintId of intent.hintIds) if (!/^h\d{3,}$/.test(hintId)) throw new Error(`invalid Hint id: ${hintId}`);
    requireIntentDescription(intent.description);
    requireShortDescription(intent.createdBy, "createdBy");
    timestamp(intent.createdAt, `Intent ${intent.id}.createdAt`);
    if ((intent.concludedBy === null) !== (intent.concludedAt === null)) throw new Error(`Intent ${intent.id} has incomplete conclusion metadata`);
    if (intent.concludedBy !== null) requireShortDescription(intent.concludedBy, "concludedBy");
    if (intent.concludedAt !== null) timestamp(intent.concludedAt, `Intent ${intent.id}.concludedAt`);
    if ((intent.to === null) !== (intent.concludedAt === null)) throw new Error(`Intent ${intent.id} has inconsistent conclusion state`);
  }
  if (completions !== 1) throw new Error("completed Project archive must have exactly one Goal completion");
  const hintIds = new Set<string>();
  for (const hint of graph.hints) {
    if (!/^h\d{3,}$/.test(hint.id) || hintIds.has(hint.id)) throw new Error(`invalid or duplicate Hint id: ${hint.id}`);
    hintIds.add(hint.id);
    requireShortDescription(hint.content, "hint.content");
    requireShortDescription(hint.creator, "hint.creator");
    timestamp(hint.createdAt, `Hint ${hint.id}.createdAt`);
    if ((hint.consumedByIntentId === null) !== (hint.consumedAt === null)) throw new Error(`Hint ${hint.id} has incomplete consumption metadata`);
    if (hint.consumedByIntentId !== null && !intentIds.has(hint.consumedByIntentId)) throw new Error(`Hint ${hint.id} references an unknown Intent`);
    if (hint.consumedAt !== null) timestamp(hint.consumedAt, `Hint ${hint.id}.consumedAt`);
  }
}

function parseProjectArchiveManifest(value: unknown): ProjectArchiveManifest {
  const manifest = record(value, "manifest");
  exact(manifest, ["format", "exportedAt", "project", "graph", "database", "artifacts"], "manifest");
  if (manifest.format !== PROJECT_ARCHIVE_FORMAT) throw new Error("unsupported Project archive format");
  if (typeof manifest.exportedAt !== "string" || !/^\d{8}T\d{6}\.\d{3}$/.test(manifest.exportedAt)) {
    throw new Error("invalid Project archive exportedAt");
  }
  if (manifest.graph !== PROJECT_ARCHIVE_GRAPH || manifest.database !== PROJECT_ARCHIVE_DATABASE) {
    throw new Error("invalid Project archive file layout");
  }
  const project = record(manifest.project, "manifest.project");
  exact(project, ["id", "source", "goal"], "manifest.project");
  const id = string(project.id, "manifest.project.id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("invalid Project archive id");
  }
  if (!Array.isArray(manifest.artifacts)) throw new Error("manifest.artifacts must be an array");
  const seen = new Set<string>();
  const artifacts = manifest.artifacts.map((value, index): ArtifactRef => {
    const item = record(value, `manifest.artifacts[${index}]`);
    exact(item, ["path", "sha256", "mediaType", "sizeBytes", "filename"], `manifest.artifacts[${index}]`);
    const sha256 = string(item.sha256, "artifact.sha256");
    if (!/^[0-9a-f]{64}$/.test(sha256) || seen.has(sha256)) throw new Error("invalid or duplicate Project archive Artifact hash");
    seen.add(sha256);
    if (item.path !== `artifacts/${sha256}`) throw new Error("invalid Project archive Artifact path");
    if (!Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0) throw new Error("invalid Project archive Artifact size");
    if (item.filename !== null && typeof item.filename !== "string") throw new Error("invalid Project archive Artifact filename");
    const artifact: ArtifactRef = {
      path: item.path,
      sha256,
      mediaType: string(item.mediaType, "artifact.mediaType"),
      sizeBytes: item.sizeBytes as number,
      filename: item.filename as string | null,
    };
    validateArtifact(artifact);
    return artifact;
  });
  const source = string(project.source, "manifest.project.source");
  const goal = string(project.goal, "manifest.project.goal");
  requireDescription(source, "manifest.project.source");
  requireDescription(goal, "manifest.project.goal");
  return {
    format: PROJECT_ARCHIVE_FORMAT,
    exportedAt: manifest.exportedAt,
    project: { id: id.toLowerCase(), source, goal },
    graph: PROJECT_ARCHIVE_GRAPH,
    database: PROJECT_ARCHIVE_DATABASE,
    artifacts,
  };
}

function validateExtractedTree(stagingDir: string, manifest: ProjectArchiveManifest): void {
  const expectedTop = new Set([PROJECT_ARCHIVE_MANIFEST, PROJECT_ARCHIVE_GRAPH, PROJECT_ARCHIVE_DATABASE, "artifacts"]);
  const top = readdirSync(stagingDir);
  if (top.some((name) => !expectedTop.has(name)) || [...expectedTop].some((name) => !top.includes(name))) {
    throw new Error("invalid Project archive top-level layout");
  }
  for (const file of [PROJECT_ARCHIVE_MANIFEST, PROJECT_ARCHIVE_GRAPH, PROJECT_ARCHIVE_DATABASE]) {
    if (!regularFile(join(stagingDir, file))) throw new Error(`invalid Project archive file: ${file}`);
  }
  const artifactsDir = join(stagingDir, "artifacts");
  const artifactsStat = lstatSync(artifactsDir);
  if (!artifactsStat.isDirectory() || artifactsStat.isSymbolicLink()) throw new Error("invalid Project archive artifacts directory");
  const expectedArtifacts = new Set(manifest.artifacts.map((artifact) => artifact.sha256));
  const actualArtifacts = readdirSync(artifactsDir);
  if (actualArtifacts.some((name) => !expectedArtifacts.has(name)) || [...expectedArtifacts].some((name) => !actualArtifacts.includes(name))) {
    throw new Error("Project archive Artifact set does not match its manifest");
  }
  for (const name of actualArtifacts) {
    if (!regularFile(join(artifactsDir, name))) throw new Error(`invalid Project archive Artifact: ${name}`);
  }
}

function archiveEntry(path: string, type: string): boolean {
  if (path === PROJECT_ARCHIVE_MANIFEST || path === PROJECT_ARCHIVE_GRAPH || path === PROJECT_ARCHIVE_DATABASE) return type === "File";
  if (path === "artifacts" || path === "artifacts/") return type === "Directory";
  return /^artifacts\/[0-9a-f]{64}$/.test(path) && type === "File";
}

function validateArtifact(artifact: ArtifactRef): void {
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256) || artifact.path !== `artifacts/${artifact.sha256}`) throw new Error("invalid Artifact reference");
  requireDescription(artifact.mediaType, "artifact.mediaType");
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) throw new Error("invalid Artifact size");
  if (artifact.filename !== null) {
    requireShortDescription(artifact.filename, "artifact.filename");
    if (artifact.filename.includes("\\") || artifact.filename.startsWith("/")
      || artifact.filename.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))) {
      throw new Error("invalid Artifact filename");
    }
  }
}

function validateFactRef(ref: FactRef, allowGoal: boolean): void {
  requireUuid(ref.projectId);
  if (ref.factId === "goal") {
    if (!allowGoal) throw new Error("Goal cannot be an Intent source");
  } else if (ref.factId !== "origin" && !/^f\d{3,}$/.test(ref.factId)) {
    throw new Error(`invalid FactRef Fact id: ${ref.factId}`);
  }
  requireDescription(ref.description, "FactRef.description");
}

function timestamp(value: string, label: string): void {
  if (!/^\d{8}T\d{6}\.\d{3}$/.test(value)) throw new Error(`invalid ${label}`);
}

function regularFile(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch (error) { throw new Error(`invalid Project archive ${label} JSON: ${(error as Error).message}`); }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[], label: string): void {
  const invalid = Object.keys(value).find((key) => !allowed.includes(key));
  const missing = allowed.find((key) => !(key in value));
  if (invalid || missing) throw new Error(invalid ? `${label} contains unknown field: ${invalid}` : `${label} is missing field: ${missing}`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}
