import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { initializeProjectDirectory } from "../utils/paths.js";
import {
  ApiError, localTimestamp, requireCustomProfileDigest, requireDescription, requireFactDescription, requireIntentDescription, requireShortDescription,
} from "./api.js";
import {
  leafFacts, type AddHintInput, type ArtifactRef, type CompleteInput, type ConcludeInput, type CreateIntentInput, type CreateProjectInput,
  type Fact, type FactRef, type Hint, type Intent, type ProjectGraph, type ProjectMeta, type ProjectStatus, type ReopenInput,
} from "./types.js";

export class SqliteStore {
  readonly database: DatabaseSync;
  private readonly projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = initializeProjectDirectory(projectDir);
    this.database = backend.open(join(this.projectDir, "project.db"));
    // WAL keeps concurrent readers live during writes; busy_timeout makes a
    // writer wait instead of failing fast when another connection holds the
    // write lock, so concurrent HTTP requests (parallel Execute workers,
    // Plan/Supervise rounds) do not surface transient "database is locked".
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;");
    this.database.exec(SCHEMA);
    this.migrateSchema();
  }

  initialize(id: string, input: CreateProjectInput): ProjectMeta {
    if (this.project()) throw new Error("project already initialized");
    const now = localTimestamp();
    this.transaction(() => {
      this.database.prepare("INSERT INTO project(id,title,status,scope,created_at) VALUES(?,?,?,?,?)")
        .run(id, requireShortDescription(input.title, "title"), "active", input.scope ?? null, now);
      this.database.prepare("INSERT INTO facts(id,description,artifact_sha256,created_at) VALUES(?,?,?,?)")
        .run("origin", requireDescription(input.target, "target"), null, now);
      this.database.prepare("INSERT INTO facts(id,description,artifact_sha256,created_at) VALUES(?,?,?,?)")
        .run("goal", requireDescription(input.goal, "goal"), null, now);
      this.database.prepare("INSERT INTO counters(name,value) VALUES('fact',0),('intent',0),('hint',0)").run();
    });
    return this.project()!;
  }

  close(): void { this.database.close(); }

  async backupTo(path: string): Promise<void> {
    await backend.backup(this.database, path);
  }

  validatePortableArchive(): void {
    const integrity = this.database.prepare("PRAGMA quick_check").get();
    if (text(integrity?.quick_check) !== "ok") throw new Error("Project archive database integrity check failed");
    const expected = ["artifacts", "counters", "facts", "hints", "intent_sources", "intents", "project"];
    const actual = this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((row) => text(row.name));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Project archive database has an invalid schema");
    const executableSchema = this.database.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view') AND name NOT LIKE 'sqlite_%'").get();
    if (executableSchema) throw new Error("Project archive database contains unsupported triggers or views");
    if (this.database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Project archive database has invalid foreign keys");
  }

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

  private facts(): Fact[] {
    return this.database.prepare(`SELECT f.*,a.path,a.media_type,a.size_bytes,a.filename FROM facts f
      LEFT JOIN artifacts a ON a.sha256=f.artifact_sha256 ORDER BY f.created_at,f.id`).all().map(fact);
  }

  fact(id: string): Fact | undefined {
    const row = this.database.prepare(`SELECT f.*,a.path,a.media_type,a.size_bytes,a.filename FROM facts f
      LEFT JOIN artifacts a ON a.sha256=f.artifact_sha256 WHERE f.id=?`).get(id);
    return row ? fact(row) : undefined;
  }

  private intents(projectId: string): Intent[] {
    const rows = this.database.prepare("SELECT * FROM intents ORDER BY created_at,id").all();
    const descriptions = new Map(this.database.prepare("SELECT id,description FROM facts").all()
      .map((row) => [text(row.id), text(row.description)]));
    const sources = new Map<string, FactRef[]>();
    for (const source of this.database.prepare("SELECT * FROM intent_sources ORDER BY intent_id,position").all()) {
      append(sources, text(source.intent_id), {
        projectId: text(source.source_project_id), id: text(source.source_fact_id),
        description: text(source.source_description),
      });
    }
    const consumedHints = new Map<string, string[]>();
    for (const hint of this.database.prepare("SELECT id,consumed_by_intent_id FROM hints WHERE consumed_by_intent_id IS NOT NULL").all()) {
      append(consumedHints, text(hint.consumed_by_intent_id), text(hint.id));
    }
    return rows.map((row) => ({
      id: text(row.id),
      from: sources.get(text(row.id)) ?? [],
      to: row.to_fact_id === null ? null : {
        projectId, id: text(row.to_fact_id), description: descriptions.get(text(row.to_fact_id))!,
      },
      customProfile: nullableNull(row.custom_profile),
      customProfileDigest: nullableNull(row.custom_profile_digest),
      hintIds: consumedHints.get(text(row.id)) ?? [],
      description: text(row.description), createdBy: text(row.created_by), createdAt: text(row.created_at),
      concludedBy: nullableNull(row.concluded_by), concludedAt: nullableNull(row.concluded_at),
    }));
  }

  private hints(): Hint[] {
    return this.database.prepare("SELECT * FROM hints ORDER BY created_at,id").all().map((row) => ({
      id: text(row.id), content: text(row.content), creator: text(row.creator), createdAt: text(row.created_at),
      consumedByIntentId: nullableNull(row.consumed_by_intent_id), consumedAt: nullableNull(row.consumed_at),
    }));
  }

  registerArtifact(ref: ArtifactRef): ArtifactRef {
    this.database.prepare(`INSERT INTO artifacts(sha256,path,media_type,size_bytes,filename,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(sha256) DO NOTHING`).run(ref.sha256, ref.path, ref.mediaType, ref.sizeBytes, ref.filename, localTimestamp());
    return this.artifact(ref.sha256)!;
  }

  /** Artifact hashes orphaned before the given local timestamp. */
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
    return row ? artifact(row) : undefined;
  }

  artifacts(): ArtifactRef[] {
    return this.database.prepare("SELECT * FROM artifacts ORDER BY sha256").all().map(artifact);
  }

  addHint(input: AddHintInput): Hint {
    const content = requireShortDescription(input.content, "content");
    const existing = this.database.prepare("SELECT id FROM hints WHERE trim(content)=?").get(content);
    if (existing) throw new ApiError(409, "duplicate hint");
    const id = this.nextId("hint", "h");
    const createdAt = localTimestamp();
    this.database.prepare("INSERT INTO hints(id,content,creator,created_at,consumed_by_intent_id,consumed_at) VALUES(?,?,?,?,NULL,NULL)")
      .run(id, content, requireShortDescription(input.creator, "creator"), createdAt);
    return { id, content, creator: input.creator.trim(), createdAt, consumedByIntentId: null, consumedAt: null };
  }

  createIntent(input: CreateIntentInput): Intent {
    this.requireActive();
    if (input.from.length === 0) throw new ApiError(400, "intent requires a source");
    const id = this.nextId("intent", "i");
    const createdAt = localTimestamp();
    const description = requireIntentDescription(input.description);
    const createdBy = requireShortDescription(input.createdBy, "createdBy");
    const customProfile = input.customProfile === undefined || input.customProfile === null
      ? null : requireShortDescription(input.customProfile, "customProfile");
    const customProfileDigest = input.customProfileDigest === undefined || input.customProfileDigest === null
      ? null : requireCustomProfileDigest(input.customProfileDigest);
    if ((customProfile === null) !== (customProfileDigest === null)) {
      throw new ApiError(400, "customProfile and customProfileDigest must be configured together");
    }
    const hintIds = uniqueIds(input.hintIds ?? [], "hintIds");
    this.transaction(() => {
      this.database.prepare(`INSERT INTO intents(id,to_fact_id,custom_profile,custom_profile_digest,description,created_by,created_at,concluded_by,concluded_at)
        VALUES(?,NULL,?,?,?,?,?,NULL,NULL)`).run(id, customProfile, customProfileDigest, description, createdBy, createdAt);
      this.insertSources(id, input.from);
      this.consumeHints(id, hintIds, createdAt);
    });
    return { id, from: input.from, to: null, customProfile, customProfileDigest, hintIds, description, createdBy, createdAt, concludedBy: null, concludedAt: null };
  }

  /**
   * Concludes an open Intent atomically: creates exactly one new immutable
   * local Fact (optionally bound to a registered Artifact) and points the
   * Intent's `to` at it in the same transaction. Concurrent conclusions race
   * on `to_fact_id`, so only the first one wins.
   */
  conclude(intentId: string, input: ConcludeInput): { intent: Intent; fact: Fact } {
    this.requireActive();
    const description = requireFactDescription(input.description);
    const concludedBy = requireShortDescription(input.concludedBy, "concludedBy");
    const artifact = input.artifact;
    if (artifact && !this.artifact(artifact.sha256)) throw new ApiError(400, "artifact not found");
    let created!: Fact;
    this.transaction(() => {
      const intent = this.database.prepare("SELECT to_fact_id FROM intents WHERE id=?").get(intentId);
      if (!intent) throw new ApiError(404, "intent not found");
      if (intent.to_fact_id !== null) throw new ApiError(409, "intent already concluded");
      const id = this.nextId("fact", "f");
      const createdAt = localTimestamp();
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

  /**
   * Completes the Project atomically: creates the single completion Intent
   * from the proof FactRefs to `goal` and flips the Project status to
   * `completed` in one transaction. A Project with an existing completion is
   * rejected with 409.
   */
  complete(input: CompleteInput): Intent {
    this.requireActive();
    const current = this.database.prepare("SELECT id FROM intents WHERE to_fact_id='goal'").get();
    if (current) throw new ApiError(409, "project already has a completion");
    const id = this.nextId("intent", "i");
    const now = localTimestamp();
    const description = requireIntentDescription(input.description);
    const actor = requireShortDescription(input.completedBy, "completedBy");
    const hintIds = uniqueIds(input.hintIds ?? [], "hintIds");
    this.transaction(() => {
      this.database.prepare(`INSERT INTO intents(id,to_fact_id,custom_profile,custom_profile_digest,description,created_by,created_at,concluded_by,concluded_at)
        VALUES(?,'goal',NULL,NULL,?,?,?,?,?)`).run(id, description, actor, now, actor, now);
      this.insertSources(id, input.from);
      this.consumeHints(id, hintIds, now);
      this.database.prepare("UPDATE project SET status='completed'").run();
    });
    return this.intents(this.project()!.id).find((item) => item.id === id)!;
  }

  /**
   * Reopens a completed Project: deletes the completion Intent (releasing its
   * consumed Hints), records the external feedback as a new immutable Fact
   * sourced from all current local leaves via a concluded `External feedback`
   * Intent, and flips the Project back to `active` — so work resumes from the
   * feedback leaf, never from a stale historical node.
   */
  reopen(input: ReopenInput): ProjectGraph {
    const project = this.project();
    if (!project || project.status !== "completed") throw new ApiError(409, "project is not completed");
    const completion = this.database.prepare("SELECT id FROM intents WHERE to_fact_id='goal'").get();
    if (!completion) throw new ApiError(409, "completion not found");
    const sources = leafFacts(this.graph()).map((fact): FactRef => ({
      projectId: project.id, id: fact.id, description: fact.description,
    }));
    if (sources.length === 0) throw new ApiError(409, "completed project has no current leaf Facts");
    const description = requireFactDescription(input.description);
    const creator = requireShortDescription(input.creator, "creator");
    this.transaction(() => {
      this.database.prepare("UPDATE hints SET consumed_by_intent_id=NULL,consumed_at=NULL WHERE consumed_by_intent_id=?").run(completion.id);
      this.database.prepare("DELETE FROM intent_sources WHERE intent_id=?").run(completion.id);
      this.database.prepare("DELETE FROM intents WHERE id=?").run(completion.id);
      const factId = this.nextId("fact", "f");
      const intentId = this.nextId("intent", "i");
      const now = localTimestamp();
      this.database.prepare("INSERT INTO facts(id,description,artifact_sha256,created_at) VALUES(?,?,?,?)")
        .run(factId, description, null, now);
      this.database.prepare(`INSERT INTO intents(id,to_fact_id,custom_profile,custom_profile_digest,description,created_by,created_at,concluded_by,concluded_at)
        VALUES(?,?,NULL,NULL,?,?,?,?,?)`).run(intentId, factId, "External feedback", creator, now, creator, now);
      this.insertSources(intentId, sources);
      this.database.prepare("UPDATE project SET status='active'").run();
    });
    return this.graph();
  }

  setStatus(status: "active" | "stopped"): ProjectMeta {
    const project = this.project();
    if (!project || project.status === "completed") throw new ApiError(409, "completed project must be reopened");
    this.database.prepare("UPDATE project SET status=?").run(status);
    return this.project()!;
  }

  private insertSources(intentId: string, sources: FactRef[]): void {
    const insert = this.database.prepare(`INSERT INTO intent_sources(intent_id,position,source_project_id,source_fact_id,source_description)
      VALUES(?,?,?,?,?)`);
    sources.forEach((source, position) => insert.run(
      intentId, position, source.projectId, source.id, source.description,
    ));
  }

  private consumeHints(intentId: string, hintIds: string[], consumedAt: string): void {
    const select = this.database.prepare("SELECT consumed_by_intent_id FROM hints WHERE id=?");
    const update = this.database.prepare("UPDATE hints SET consumed_by_intent_id=?,consumed_at=? WHERE id=?");
    for (const hintId of hintIds) {
      const row = select.get(hintId);
      if (!row) throw new ApiError(400, `hint not found: ${hintId}`);
      if (row.consumed_by_intent_id !== null) throw new ApiError(409, `hint already consumed: ${hintId}`);
      update.run(intentId, consumedAt, hintId);
    }
  }

  private migrateSchema(): void {
    this.makeFactArtifactOptional();
    addColumn(this.database, "intents", "custom_profile", "TEXT");
    addColumn(this.database, "intents", "custom_profile_digest", "TEXT");
    dropColumn(this.database, "facts", "kind");
    dropColumn(this.database, "intents", "prompt_kind");
    dropColumn(this.database, "hints", "kind");
    addColumn(this.database, "hints", "consumed_by_intent_id", "TEXT");
    addColumn(this.database, "hints", "consumed_at", "TEXT");
    addColumn(this.database, "intent_sources", "source_description", "TEXT NOT NULL DEFAULT ''");
    addColumn(this.database, "artifacts", "filename", "TEXT");
    const project = this.project();
    if (project) {
      this.database.prepare(`UPDATE intent_sources SET source_description=(
        SELECT description FROM facts WHERE facts.id=intent_sources.source_fact_id
      ) WHERE source_project_id=? AND source_description=''`).run(project.id);
    }
  }

  private makeFactArtifactOptional(): void {
    const artifact = this.database.prepare("PRAGMA table_info(facts)").all()
      .find((row) => text(row.name) === "artifact_sha256");
    if (!artifact || number(artifact.notnull) === 0) return;
    this.database.exec("PRAGMA foreign_keys=OFF");
    try {
      this.database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE facts_optional(id TEXT PRIMARY KEY,description TEXT NOT NULL,artifact_sha256 TEXT REFERENCES artifacts(sha256),created_at TEXT NOT NULL);
        INSERT INTO facts_optional(id,description,artifact_sha256,created_at) SELECT id,description,artifact_sha256,created_at FROM facts;
        DROP TABLE facts;
        ALTER TABLE facts_optional RENAME TO facts;
        COMMIT;`);
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys=ON");
    }
  }

  private nextId(counter: "fact" | "intent" | "hint", prefix: string): string {
    this.database.prepare("UPDATE counters SET value=value+1 WHERE name=?").run(counter);
    const row = this.database.prepare("SELECT value FROM counters WHERE name=?").get(counter);
    return `${prefix}${String(number(row?.value)).padStart(4, "0")}`;
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
CREATE TABLE IF NOT EXISTS artifacts(sha256 TEXT PRIMARY KEY,path TEXT NOT NULL,media_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,filename TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY,description TEXT NOT NULL,artifact_sha256 TEXT REFERENCES artifacts(sha256),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,to_fact_id TEXT REFERENCES facts(id),custom_profile TEXT,custom_profile_digest TEXT,description TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,concluded_by TEXT,concluded_at TEXT);
CREATE TABLE IF NOT EXISTS intent_sources(intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,position INTEGER NOT NULL,source_project_id TEXT NOT NULL,source_fact_id TEXT NOT NULL,source_description TEXT NOT NULL,PRIMARY KEY(intent_id,position),UNIQUE(intent_id,source_project_id,source_fact_id));
CREATE TABLE IF NOT EXISTS hints(id TEXT PRIMARY KEY,content TEXT NOT NULL,creator TEXT NOT NULL,created_at TEXT NOT NULL,consumed_by_intent_id TEXT REFERENCES intents(id),consumed_at TEXT);
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
`;

function fact(row: Record<string, unknown>): Fact {
  const sha256 = nullable(row.artifact_sha256);
  return {
    id: text(row.id), description: text(row.description), createdAt: text(row.created_at),
    artifact: sha256
      ? { path: text(row.path), sha256, mediaType: text(row.media_type), sizeBytes: number(row.size_bytes), filename: nullableNull(row.filename) }
      : null,
  };
}
function artifact(row: Record<string, unknown>): ArtifactRef {
  return {
    path: text(row.path), sha256: text(row.sha256), mediaType: text(row.media_type),
    sizeBytes: number(row.size_bytes), filename: nullableNull(row.filename),
  };
}
function addColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => text(row.name));
  if (!columns.includes(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function dropColumn(database: DatabaseSync, table: string, column: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => text(row.name));
  if (columns.includes(column)) database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
function uniqueIds(values: string[], label: string): string[] {
  if (!Array.isArray(values)) throw new ApiError(400, `${label} must be an array`);
  const result = values.map((value) => requireShortDescription(value, label));
  if (new Set(result).size !== result.length) throw new ApiError(400, `${label} contains duplicates`);
  return result;
}
function text(value: unknown): string { return String(value); }
function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}
function nullable(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }
function nullableNull(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function number(value: unknown): number { return Number(value ?? 0); }

/** Minimal structural typing for bun:sqlite (no bun-types dependency). */
interface BunStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | null;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface BunDatabase {
  exec(sql: string): void;
  prepare(sql: string): BunStatement;
  close(): void;
  serialize(): Uint8Array;
}

interface SqliteBackend {
  open(path: string): DatabaseSync;
  backup(database: DatabaseSync, path: string): Promise<void>;
}

/**
 * Runtime SQLite backend detection: Bun does not implement node:sqlite, so the
 * same compiled artifact loads node:sqlite under Node and bun:sqlite under Bun.
 * createRequire("bun:sqlite") is verified to work both under bare `bun` and in
 * `bun build --compile` binaries. The Bun adapter normalizes StatementSync.get
 * to return `undefined` (not null) for missing rows; backup uses serialize().
 */
const backend: SqliteBackend = (() => {
  const requireModule = createRequire(import.meta.url);
  if (process.versions.bun) {
    const { Database } = requireModule("bun:sqlite") as { Database: new (path: string) => BunDatabase };
    return {
      open(path) {
        const database = new Database(path);
        const adapted: DatabaseSync & { serialize(): Uint8Array } = {
          exec: (sql: string) => database.exec(sql),
          prepare: (sql: string) => {
            const statement = database.prepare(sql);
            // Only run/get/all are used by this store; cast to the full
            // node:sqlite StatementSync shape (type-level only).
            return {
              run: (...params: unknown[]) => statement.run(...params),
              get: (...params: unknown[]) => statement.get(...params) ?? undefined,
              all: (...params: unknown[]) => statement.all(...params),
            } as unknown as StatementSync;
          },
          close: () => database.close(),
          serialize: () => database.serialize(),
        };
        return adapted;
      },
      async backup(database, path) {
        writeFileSync(path, (database as DatabaseSync & { serialize(): Uint8Array }).serialize());
      },
    };
  }
  const { DatabaseSync: NodeDatabaseSync, backup } = requireModule("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSync;
    backup: (database: DatabaseSync, path: string) => Promise<void>;
  };
  return {
    open: (path) => new NodeDatabaseSync(path),
    backup,
  };
})();
