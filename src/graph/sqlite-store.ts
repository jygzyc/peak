import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApiError, requireDescription } from "./api.js";
import type {
  AddHintInput, ArtifactRef, CompleteInput, ConcludeInput, CreateIntentInput, CreateProjectInput,
  Fact, FactRef, Hint, Intent, ProjectGraph, ProjectMeta, ProjectStatus, ReopenInput,
} from "./types.js";

export class SqliteStore {
  readonly database: DatabaseSync;

  constructor(readonly projectDir: string) {
    mkdirSync(projectDir, { recursive: true });
    this.database = new DatabaseSync(join(projectDir, "analysis.db"));
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    this.database.exec(SCHEMA);
  }

  initialize(id: string, input: CreateProjectInput): ProjectMeta {
    if (this.project()) throw new Error("project already initialized");
    const now = timestamp();
    this.transaction(() => {
      this.database.prepare("INSERT INTO project(id,title,status,scope,created_at) VALUES(?,?,?,?,?)")
        .run(id, requireDescription(input.title, "title"), "active", input.scope ?? null, now);
      this.database.prepare("INSERT INTO facts(id,description,artifact_sha256,created_at) VALUES(?,?,NULL,?)")
        .run("origin", requireDescription(input.target, "target"), now);
      this.database.prepare("INSERT INTO facts(id,description,artifact_sha256,created_at) VALUES(?,?,NULL,?)")
        .run("goal", requireDescription(input.goal, "goal"), now);
      this.database.prepare("INSERT INTO counters(name,value) VALUES('fact',0),('intent',0),('hint',0)").run();
    });
    return this.project()!;
  }

  close(): void { this.database.close(); }

  project(): ProjectMeta | undefined {
    const row = this.database.prepare("SELECT * FROM project LIMIT 1").get();
    if (!row) return undefined;
    return {
      id: text(row.id), title: text(row.title), status: text(row.status) as ProjectStatus,
      scope: nullable(row.scope), createdAt: text(row.created_at),
    };
  }

  graph(): ProjectGraph {
    const project = this.project();
    if (!project) throw new ApiError(404, "project not found");
    return { project, facts: this.facts(), intents: this.intents(project.id), hints: this.hints() };
  }

  facts(): Fact[] {
    return this.database.prepare(`SELECT f.*,a.path,a.media_type,a.size_bytes FROM facts f
      LEFT JOIN artifacts a ON a.sha256=f.artifact_sha256 ORDER BY f.created_at,f.id`).all().map(fact);
  }

  fact(id: string): Fact | undefined {
    const row = this.database.prepare(`SELECT f.*,a.path,a.media_type,a.size_bytes FROM facts f
      LEFT JOIN artifacts a ON a.sha256=f.artifact_sha256 WHERE f.id=?`).get(id);
    return row ? fact(row) : undefined;
  }

  intents(projectId: string): Intent[] {
    const rows = this.database.prepare("SELECT * FROM intents ORDER BY created_at,id").all();
    const sources = this.database.prepare("SELECT * FROM intent_sources ORDER BY intent_id,position").all();
    return rows.map((row) => ({
      id: text(row.id),
      from: sources.filter((source) => source.intent_id === row.id).map((source) => ({
        projectId: text(source.source_project_id), factId: text(source.source_fact_id),
      })),
      to: row.to_fact_id === null ? null : { projectId, factId: text(row.to_fact_id) },
      description: text(row.description), createdBy: text(row.created_by), createdAt: text(row.created_at),
      concludedBy: nullableNull(row.concluded_by), concludedAt: nullableNull(row.concluded_at),
    }));
  }

  hints(): Hint[] {
    return this.database.prepare("SELECT * FROM hints ORDER BY created_at,id").all().map((row) => ({
      id: text(row.id), content: text(row.content), creator: text(row.creator), createdAt: text(row.created_at),
    }));
  }

  registerArtifact(ref: ArtifactRef): ArtifactRef {
    this.database.prepare(`INSERT INTO artifacts(sha256,path,media_type,size_bytes,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(sha256) DO NOTHING`).run(ref.sha256, ref.path, ref.mediaType, ref.sizeBytes, timestamp());
    return this.artifact(ref.sha256)!;
  }

  orphanArtifacts(before: string): string[] {
    return this.database.prepare(`SELECT a.sha256 FROM artifacts a LEFT JOIN facts f ON f.artifact_sha256=a.sha256
      WHERE f.id IS NULL AND a.created_at < ?`).all(before).map((row) => text(row.sha256));
  }

  removeArtifact(sha256: string): void {
    this.database.prepare("DELETE FROM artifacts WHERE sha256=? AND NOT EXISTS(SELECT 1 FROM facts WHERE artifact_sha256=?)")
      .run(sha256, sha256);
  }

  artifact(sha256: string): ArtifactRef | undefined {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE sha256=?").get(sha256);
    return row ? { path: text(row.path), sha256: text(row.sha256), mediaType: text(row.media_type), sizeBytes: number(row.size_bytes) } : undefined;
  }

  addHint(input: AddHintInput): Hint {
    const content = requireDescription(input.content, "content");
    const existing = this.database.prepare("SELECT id FROM hints WHERE trim(content)=?").get(content);
    if (existing) throw new ApiError(409, "duplicate hint");
    const id = this.nextId("hint", "h");
    const createdAt = timestamp();
    this.database.prepare("INSERT INTO hints(id,content,creator,created_at) VALUES(?,?,?,?)")
      .run(id, content, requireDescription(input.creator, "creator"), createdAt);
    return { id, content, creator: input.creator.trim(), createdAt };
  }

  createIntent(input: CreateIntentInput): Intent {
    this.requireActive();
    if (input.from.length === 0) throw new ApiError(400, "intent requires a source");
    const id = this.nextId("intent", "i");
    const createdAt = timestamp();
    const description = requireDescription(input.description);
    const createdBy = requireDescription(input.createdBy, "createdBy");
    this.transaction(() => {
      this.database.prepare(`INSERT INTO intents(id,to_fact_id,description,created_by,created_at,concluded_by,concluded_at)
        VALUES(?,NULL,?,?,?,NULL,NULL)`).run(id, description, createdBy, createdAt);
      this.insertSources(id, input.from);
    });
    return { id, from: input.from, to: null, description, createdBy, createdAt, concludedBy: null, concludedAt: null };
  }

  conclude(intentId: string, input: ConcludeInput): { intent: Intent; fact: Fact } {
    this.requireActive();
    const description = requireDescription(input.description);
    const concludedBy = requireDescription(input.concludedBy, "concludedBy");
    const artifact = input.artifact ?? null;
    if (artifact && !this.artifact(artifact.sha256)) throw new ApiError(400, "artifact not found");
    let created!: Fact;
    this.transaction(() => {
      const intent = this.database.prepare("SELECT to_fact_id FROM intents WHERE id=?").get(intentId);
      if (!intent) throw new ApiError(404, "intent not found");
      if (intent.to_fact_id !== null) throw new ApiError(409, "intent already concluded");
      const id = this.nextId("fact", "f");
      const createdAt = timestamp();
      this.database.prepare("INSERT INTO facts(id,description,artifact_sha256,created_at) VALUES(?,?,?,?)")
        .run(id, description, artifact?.sha256 ?? null, createdAt);
      this.database.prepare("UPDATE intents SET to_fact_id=?,concluded_by=?,concluded_at=? WHERE id=?")
        .run(id, concludedBy, createdAt, intentId);
      created = { id, description, artifact, createdAt };
    });
    const projectId = this.project()!.id;
    const intent = this.intents(projectId).find((item) => item.id === intentId)!;
    return { intent, fact: created };
  }

  complete(input: CompleteInput): Intent {
    this.requireActive();
    const current = this.database.prepare("SELECT id FROM intents WHERE to_fact_id='goal'").get();
    if (current) throw new ApiError(409, "project already has a completion");
    const id = this.nextId("intent", "i");
    const now = timestamp();
    const description = requireDescription(input.description);
    const actor = requireDescription(input.completedBy, "completedBy");
    this.transaction(() => {
      this.database.prepare(`INSERT INTO intents(id,to_fact_id,description,created_by,created_at,concluded_by,concluded_at)
        VALUES(?,'goal',?,?,?,?,?)`).run(id, description, actor, now, actor, now);
      this.insertSources(id, input.from);
      this.database.prepare("UPDATE project SET status='completed'").run();
    });
    return this.intents(this.project()!.id).find((item) => item.id === id)!;
  }

  reopen(input: ReopenInput): ProjectGraph {
    const project = this.project();
    if (!project || project.status !== "completed") throw new ApiError(409, "project is not completed");
    const completion = this.database.prepare("SELECT id FROM intents WHERE to_fact_id='goal'").get();
    if (!completion) throw new ApiError(409, "completion not found");
    const description = requireDescription(input.description);
    const creator = requireDescription(input.creator, "creator");
    this.transaction(() => {
      this.database.prepare("DELETE FROM intent_sources WHERE intent_id=?").run(completion.id);
      this.database.prepare("DELETE FROM intents WHERE id=?").run(completion.id);
      const factId = this.nextId("fact", "f");
      const intentId = this.nextId("intent", "i");
      const now = timestamp();
      this.database.prepare("INSERT INTO facts(id,description,artifact_sha256,created_at) VALUES(?,?,NULL,?)")
        .run(factId, description, now);
      this.database.prepare(`INSERT INTO intents(id,to_fact_id,description,created_by,created_at,concluded_by,concluded_at)
        VALUES(?,?,?,?,?,?,?)`).run(intentId, factId, "External feedback", creator, now, creator, now);
      this.insertSources(intentId, [{ projectId: project.id, factId: "origin" }]);
      this.database.prepare("UPDATE project SET status='active'").run();
    });
    return this.graph();
  }

  setTitle(title: string): ProjectMeta {
    this.database.prepare("UPDATE project SET title=?").run(requireDescription(title, "title"));
    return this.project()!;
  }

  setStatus(status: "active" | "stopped"): ProjectMeta {
    const project = this.project();
    if (!project || project.status === "completed") throw new ApiError(409, "completed project must be reopened");
    this.database.prepare("UPDATE project SET status=?").run(status);
    return this.project()!;
  }

  externalReferences(projectId: string): number {
    const row = this.database.prepare("SELECT count(*) count FROM intent_sources WHERE source_project_id=?").get(projectId);
    return number(row?.count);
  }

  private insertSources(intentId: string, sources: FactRef[]): void {
    const insert = this.database.prepare(`INSERT INTO intent_sources(intent_id,position,source_project_id,source_fact_id)
      VALUES(?,?,?,?)`);
    sources.forEach((source, position) => insert.run(intentId, position, source.projectId, source.factId));
  }

  private nextId(counter: "fact" | "intent" | "hint", prefix: string): string {
    this.database.prepare("UPDATE counters SET value=value+1 WHERE name=?").run(counter);
    const row = this.database.prepare("SELECT value FROM counters WHERE name=?").get(counter);
    return `${prefix}${String(number(row?.value)).padStart(3, "0")}`;
  }

  private requireActive(): void {
    if (this.project()?.status !== "active") throw new ApiError(409, "project is not active");
  }

  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try { action(); this.database.exec("COMMIT"); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,scope TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts(sha256 TEXT PRIMARY KEY,path TEXT NOT NULL,media_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY,description TEXT NOT NULL,artifact_sha256 TEXT REFERENCES artifacts(sha256),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,to_fact_id TEXT REFERENCES facts(id),description TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,concluded_by TEXT,concluded_at TEXT);
CREATE TABLE IF NOT EXISTS intent_sources(intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,position INTEGER NOT NULL,source_project_id TEXT NOT NULL,source_fact_id TEXT NOT NULL,PRIMARY KEY(intent_id,position),UNIQUE(intent_id,source_project_id,source_fact_id));
CREATE TABLE IF NOT EXISTS hints(id TEXT PRIMARY KEY,content TEXT NOT NULL,creator TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
`;

function fact(row: Record<string, unknown>): Fact {
  const sha256 = nullable(row.artifact_sha256);
  return {
    id: text(row.id), description: text(row.description), createdAt: text(row.created_at),
    artifact: sha256 ? { path: text(row.path), sha256, mediaType: text(row.media_type), sizeBytes: number(row.size_bytes) } : null,
  };
}
function timestamp(): string { return new Date().toISOString(); }
function text(value: unknown): string { return String(value); }
function nullable(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }
function nullableNull(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function number(value: unknown): number { return Number(value ?? 0); }
