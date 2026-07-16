/**
 * SQLite-backed Graph implementation.
 *
 * Persists projects, facts, intents, hints, directives, events, counters,
 * leases, and dead-end records for resumable agent runs. It is the production
 * state store used by CLI/runtime sessions.
 */

import { DatabaseSync } from "node:sqlite";
import type {
  BroadcastAssessment, Directive, DirectiveId, DirectiveInput,
  Fact, FactId, FactStatus, EndFact, GraphEvent, Hint, HintId,
  Intent, IntentId, IntentStatus, ISOTime,
  Progress, Project, ProjectId, ProjectStatus, RunId, RunStatus,
  SubagentRun, SubagentRunInput, TaskConfig, Verdict,
} from "../agent/types.js";
import {
  type FactInput, type HintInput, type IntentInput, type ProjectInput,
  type IntentLeaseClaim,
  type RunLeaseClaim,
  type FederationOutboxItem, type Graph, type MetacogCommitInput,
  newProjectId, newRunId, now, routeHash,
} from "./graph.js";

const GRAPH_APPLICATION_ID = 1346715980;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
PRAGMA application_id=${GRAPH_APPLICATION_ID};
PRAGMA user_version=1;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  session TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  worker TEXT NOT NULL,
  session_dir TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  config_path TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'candidate',
  parent_intent_id TEXT,
  reviewer_reason TEXT,
  required_conditions_json TEXT NOT NULL DEFAULT '[]',
  step_discovered INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  description TEXT NOT NULL,
  creator TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  parent_intent_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  dispatch_requested INTEGER NOT NULL,
  lease_worker_id TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_claimed_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  concluded_at TEXT,
  concluded_fact_id TEXT,
  failure_reason TEXT,
  killed_by TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS intent_sets (
  project_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (project_id, intent_id, fact_id),
  UNIQUE (project_id, intent_id, ordinal),
  FOREIGN KEY (project_id, intent_id) REFERENCES intents(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, fact_id) REFERENCES facts(project_id, id)
);

CREATE TABLE IF NOT EXISTS end_facts (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  description TEXT NOT NULL,
  from_fact_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_reason TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS federation_outbox (
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_fact_id TEXT,
  summary TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  dispatch_key TEXT,
  owner_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  broadcast_id TEXT,
  broadcast_seq INTEGER,
  PRIMARY KEY (project_id, event_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_federation_outbox_project_status
  ON federation_outbox(project_id, status);

CREATE TABLE IF NOT EXISTS hints (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  creator TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'direction',
  target_intent_id TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS directives (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS subagent_runs (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  role TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  intent_id TEXT,
  fact_id TEXT,
  parent_run_id TEXT,
  input_summary TEXT,
  output_summary TEXT,
  error_message TEXT,
  used_conclude INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  prompt_hash TEXT,
  prompt_manifest_json TEXT,
  context_artifact_json TEXT,
  output_artifact_json TEXT,
  worker_session_id TEXT,
  dispatch_key TEXT,
  owner_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_runs_project_status ON subagent_runs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_project_profile ON subagent_runs(project_id, profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active_dispatch
  ON subagent_runs(project_id, dispatch_key)
  WHERE dispatch_key IS NOT NULL AND status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, seq);

CREATE TABLE IF NOT EXISTS dead_ends (
  route_hash TEXT NOT NULL,
  project_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, route_hash)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class SqliteGraph implements Graph {
  private db: DatabaseSync;
  private inTx = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    try {
      assertDatabaseIdentity(this.db, GRAPH_APPLICATION_ID, "peak graph");
      this.db.exec(SCHEMA);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ─── Project ───

  createProject(input: ProjectInput): Project {
    const existing = this.findProject(input.session);
    if (existing) return existing;

    const id = newProjectId();
    const ts = now();
    const project: Project = {
      id, session: input.session, name: input.name,
      target: input.target, goal: input.goal,
      status: "active", worker: input.worker,
      sessionDir: input.sessionDir, workspaceDir: input.workspaceDir ?? input.sessionDir,
      configPath: input.configPath,
      taskConfig: input.taskConfig, createdAt: ts, updatedAt: ts,
    };
    this.transaction(() => {
      this.run(
        `INSERT INTO projects (id, session, name, target, goal, status, worker, session_dir, workspace_dir, config_path, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        id, input.session, input.name, input.target, input.goal,
        input.worker, input.sessionDir, input.workspaceDir ?? input.sessionDir, input.configPath,
        JSON.stringify(input.taskConfig), ts, ts,
      );
    });
    return project;
  }

  getProject(idOrSession: string): Project | undefined {
    return this.findProject(idOrSession);
  }

  listProjects(status?: ProjectStatus): Project[] {
    const sql = status
      ? "SELECT * FROM projects WHERE status = ? ORDER BY created_at"
      : "SELECT * FROM projects ORDER BY created_at";
    const rows = status ? this.all(sql, status) : this.all(sql);
    return rows.map(projectFromRow);
  }

  updateProjectStatus(id: ProjectId, status: ProjectStatus): void {
    this.transaction(() => {
      this.run("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?", status, now(), id);
      this.logEvent(id, "project.status", { status });
    });
  }

  touchProject(id: ProjectId): void {
    this.run("UPDATE projects SET updated_at = ? WHERE id = ?", now(), id);
  }

  // ─── Fact ───

  addFact(projectId: ProjectId, input: FactInput): Fact {
    return this.transaction(() => {
      this.reactivateIfFinishProposed(projectId, "fact.created");
      const counter = this.nextId(projectId, "facts", "f");
      const id = `f${String(counter).padStart(3, "0")}`;
      const ts = now();
      const stepRow = this.get("SELECT value FROM meta WHERE key = ?", `steps:${projectId}`);
      const stepDiscovered = Number(stepRow?.value ?? 0);
      const fact: Fact = {
        id, projectId, description: input.description,
        evidence: input.evidence ?? [], source: input.source,
        confidence: input.confidence ?? 1.0, status: "candidate",
        parentIntentId: input.parentIntentId, stepDiscovered, createdAt: ts,
      };
      this.run(
        `INSERT INTO facts (id, project_id, description, evidence_json, source, confidence, status, parent_intent_id, step_discovered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
        id, projectId, fact.description, JSON.stringify(fact.evidence),
        fact.source, fact.confidence, input.parentIntentId ?? null, stepDiscovered, ts,
      );
      this.logEvent(projectId, "fact.created", { factId: id, source: fact.source, description: fact.description, confidence: fact.confidence });
      return fact;
    });
  }

  getFact(projectId: ProjectId, factId: FactId): Fact | undefined {
    const row = this.get("SELECT * FROM facts WHERE project_id = ? AND id = ?", projectId, factId);
    return row ? factFromRow(row) : undefined;
  }

  facts(projectId: ProjectId, status?: FactStatus): Fact[] {
    const rows = status
      ? this.all("SELECT * FROM facts WHERE project_id = ? AND status = ? ORDER BY created_at, id", projectId, status)
      : this.all("SELECT * FROM facts WHERE project_id = ? ORDER BY created_at, id", projectId);
    return rows.map(factFromRow);
  }

  candidateFacts(projectId: ProjectId): Fact[] {
    return this.facts(projectId, "candidate");
  }

  resolveFact(projectId: ProjectId, factId: FactId, verdict: Verdict): void {
    this.transaction(() => {
      this.reactivateIfFinishProposed(projectId, "fact.resolved");
      const fact = this.get("SELECT * FROM facts WHERE project_id = ? AND id = ?", projectId, factId);
      if (!fact) throw new Error(`fact not found: ${factId}`);
      if (fact.status !== "candidate") throw new Error(`fact is not resolvable: ${factId}`);
      let newStatus: string;
      let requiredConditions: string[];
      if (verdict.decision === "pass") {
        newStatus = "pass";
        requiredConditions = [];
      } else if (verdict.decision === "deny") {
        newStatus = "deny";
        requiredConditions = [];
        this.recordDeadEnd(projectId, String(fact.description), verdict.reason);
      } else {
        // Reviewed but blocked: park on explicit conditions.
        newStatus = "pending";
        requiredConditions = verdict.requiredConditions ?? [];
      }
      const newConf = verdict.confidence !== undefined
        ? verdict.confidence
        : verdict.decision === "pending"
          ? Math.min(Number(fact.confidence), 0.35)
          : fact.confidence;
      this.run(
        "UPDATE facts SET status = ?, confidence = ?, reviewer_reason = ?, required_conditions_json = ? WHERE project_id = ? AND id = ?",
        newStatus, newConf, verdict.reason, JSON.stringify(requiredConditions), projectId, factId,
      );
      this.logEvent(projectId, "fact.resolved", { factId, verdict });
      if (verdict.decision === "pass") {
        this.run("UPDATE meta SET value = '0' WHERE key = ?", `stagnation:${projectId}`);
      }
    });
  }

  recordDeadEnd(projectId: ProjectId, description: string, reason: string): void {
    this.transaction(() => {
      const hash = routeHash(description);
      this.run(
        "INSERT OR REPLACE INTO dead_ends (project_id, route_hash, intent_id, description, reason, created_at) VALUES (?, ?, '', ?, ?, ?)",
        projectId, hash, description, reason, now(),
      );
    });
  }

  clearFactConditions(projectId: ProjectId, factId: FactId): void {
    this.transaction(() => {
      const row = this.get("SELECT status FROM facts WHERE project_id = ? AND id = ?", projectId, factId);
      if (row && row.status === "pending") {
        this.run("UPDATE facts SET status = 'candidate', required_conditions_json = '[]' WHERE project_id = ? AND id = ?", projectId, factId);
        this.logEvent(projectId, "fact.reactivated", { factId });
      }
    });
  }

  // ─── Intent ───

  addIntent(projectId: ProjectId, input: IntentInput): Intent {
    return this.transaction(() => {
      this.reactivateIfFinishProposed(projectId, "intent.created");
      // Provenance rule: an Intent is the graph edge parentFactIds →
      // concludedFactId. Edges may only originate from verified (truth) facts.
      const parentIds = input.parentFactIds ? [...input.parentFactIds] : [];
      if (new Set(parentIds).size !== parentIds.length) {
        throw new Error("intent parent facts must be unique");
      }
      for (const fid of parentIds) {
        const row = this.get("SELECT status FROM facts WHERE project_id = ? AND id = ?", projectId, fid);
        const status = row ? String(row.status) : "missing";
        if (status !== "pass") {
          throw new Error(
            `intent parent fact ${fid} is not verified (status=${status}); ` +
            `intents may only extend from verified facts`,
          );
        }
      }
      const counter = this.nextId(projectId, "intents", "i");
      const id = `i${String(counter).padStart(3, "0")}`;
      const ts = now();
      const intent: Intent = {
        id, projectId, description: input.description, creator: input.creator,
        parentFactIds: parentIds, status: "open",
        dispatchRequested: input.dispatchRequested ?? false,
        parentIntentId: input.parentIntentId, leaseEpoch: 0,
        priority: input.priority ?? 0, createdAt: ts,
      };
      this.run(
        `INSERT INTO intents (id, project_id, description, creator, status, parent_intent_id, priority, dispatch_requested, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        id, projectId, input.description, input.creator,
        input.parentIntentId ?? null,
        intent.priority, intent.dispatchRequested ? 1 : 0, ts,
      );
      for (let i = 0; i < intent.parentFactIds.length; i++) {
        this.run("INSERT INTO intent_sets (project_id, intent_id, fact_id, ordinal) VALUES (?, ?, ?, ?)",
          projectId, id, intent.parentFactIds[i], i);
      }
      this.logEvent(projectId, "intent.created", {
        intentId: id,
        description: input.description,
        creator: input.creator,
        dispatchRequested: intent.dispatchRequested,
      });
      return intent;
    });
  }

  requestExplorerDispatch(projectId: ProjectId, intentId: IntentId): void {
    this.transaction(() => {
      const row = this.get(
        "SELECT status, dispatch_requested FROM intents WHERE project_id = ? AND id = ?",
        projectId,
        intentId,
      );
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status !== "open") {
        throw new Error(`only an open intent can request explorer dispatch: ${intentId} (status=${row.status})`);
      }
      if (Number(row.dispatch_requested ?? 1) !== 0) return;
      this.run("UPDATE intents SET dispatch_requested = 1 WHERE project_id = ? AND id = ?", projectId, intentId);
      this.logEvent(projectId, "planner.explorer_dispatch_requested", { intentId });
    });
  }

  stopExplorer(projectId: ProjectId, intentId: IntentId, reason: string): void {
    this.transaction(() => {
      const intent = this.get(
        "SELECT status, lease_epoch FROM intents WHERE project_id = ? AND id = ?",
        projectId,
        intentId,
      );
      if (!intent) throw new Error(`intent not found: ${intentId}`);
      if (intent.status === "pass" || intent.status === "deny") {
        throw new Error(`intent is already terminal: ${intentId}`);
      }
      const revoke = intent.status === "claimed" ? 1 : 0;
      this.run(
        `UPDATE intents
         SET status = 'open', dispatch_requested = 0,
             lease_worker_id = NULL, lease_claimed_at = NULL, lease_expires_at = NULL,
             lease_epoch = lease_epoch + ?
         WHERE project_id = ? AND id = ?`,
        revoke,
        projectId,
        intentId,
      );
      const activeRuns = this.all(
        "SELECT id FROM subagent_runs WHERE project_id = ? AND role = 'explorer' AND intent_id = ? AND status IN ('pending', 'running')",
        projectId,
        intentId,
      );
      for (const run of activeRuns) {
        this.updateSubagentRun(projectId, String(run.id), {
          status: "cancelled",
          errorMessage: reason,
        });
      }
      this.logEvent(projectId, "planner.explorer_stopped", {
        intentId,
        reason,
        leaseEpoch: Number(intent.lease_epoch ?? 0) + revoke,
      });
    });
  }

  getIntent(projectId: ProjectId, intentId: IntentId): Intent | undefined {
    const row = this.get("SELECT * FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
    if (!row) return undefined;
    return intentFromRow(row, this.loadIntentSources(projectId, intentId));
  }

  intents(projectId: ProjectId, status?: IntentStatus): Intent[] {
    const rows = status
      ? this.all("SELECT * FROM intents WHERE project_id = ? AND status = ? ORDER BY created_at, id", projectId, status)
      : this.all("SELECT * FROM intents WHERE project_id = ? ORDER BY created_at, id", projectId);
    return rows.map((r) => intentFromRow(r, this.loadIntentSources(projectId, String(r.id))));
  }

  claimIntent(projectId: ProjectId, intentId: IntentId, workerId: string, leaseMs: number): Intent {
    return this.transaction(() => {
      const t = Date.now();
      const claimedAt = new Date(t).toISOString();
      const expiresAt = new Date(t + leaseMs).toISOString();
      const result = this.run("UPDATE intents SET status = 'claimed', lease_worker_id = ?, lease_epoch = lease_epoch + 1, lease_claimed_at = ?, lease_expires_at = ? WHERE project_id = ? AND id = ? AND status = 'open'",
        workerId, claimedAt, expiresAt, projectId, intentId);
      if (result.changes !== 1) {
        const row = this.get("SELECT status FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
        if (!row) throw new Error(`intent not found: ${intentId}`);
        throw new Error(`intent is not open: ${intentId} (status=${row.status})`);
      }
      const claimed = this.getIntent(projectId, intentId)!;
      this.logEvent(projectId, "intent.claimed", { intentId, workerId, epoch: claimed.leaseEpoch });
      return claimed;
    });
  }

  renewIntentLease(
    projectId: ProjectId,
    intentId: IntentId,
    expected: IntentLeaseClaim,
    leaseMs: number,
  ): void {
    const current = now();
    const result = this.run(
      `UPDATE intents
       SET lease_expires_at = ?
       WHERE project_id = ? AND id = ? AND status = 'claimed'
         AND lease_worker_id = ? AND lease_epoch = ?
         AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
      new Date(Date.now() + leaseMs).toISOString(),
      projectId,
      intentId,
      expected.workerId,
      expected.epoch,
      current,
    );
    if (result.changes !== 1) throw new Error(`stale or expired intent lease: ${intentId}`);
  }

  releaseIntent(projectId: ProjectId, intentId: IntentId, expected?: IntentLeaseClaim): void {
    this.transaction(() => {
      const row = this.get("SELECT status, lease_worker_id, lease_epoch FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status === "claimed") {
        if (expected && (row.lease_worker_id !== expected.workerId || Number(row.lease_epoch) !== expected.epoch)) {
          throw new Error(`stale intent lease: ${intentId}`);
        }
        this.run("UPDATE intents SET status = 'open', lease_worker_id = NULL, lease_claimed_at = NULL, lease_expires_at = NULL WHERE project_id = ? AND id = ?",
          projectId, intentId);
        this.logEvent(projectId, "intent.released", { intentId, epoch: expected?.epoch });
      }
    });
  }

  concludeIntent(projectId: ProjectId, intentId: IntentId, factId?: FactId): void {
    this.transaction(() => {
      const row = this.get("SELECT status FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status === "pass" || row.status === "deny") throw new Error(`intent already concluded: ${intentId}`);
      const ts = now();
      this.run("UPDATE intents SET status = 'pass', concluded_at = ?, concluded_fact_id = ?, lease_worker_id = NULL, lease_claimed_at = NULL, lease_expires_at = NULL WHERE project_id = ? AND id = ?",
        ts, factId ?? null, projectId, intentId);
      this.bumpStep(projectId);
      this.logEvent(projectId, "intent.concluded", { intentId, factId });
    });
  }

  failIntent(projectId: ProjectId, intentId: IntentId, reason: string, recordDeadEnd = true, killedBy: Intent["killedBy"] = undefined): void {
    this.transaction(() => {
      const row = this.get("SELECT status FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status === "deny") throw new Error(`intent already failed: ${intentId}`);
      const wasDone = row.status === "pass";
      const ts = now();
      this.run("UPDATE intents SET status = 'deny', concluded_at = ?, failure_reason = ?, killed_by = ?, lease_worker_id = NULL, lease_claimed_at = NULL, lease_expires_at = NULL WHERE project_id = ? AND id = ?",
        ts, reason, killedBy ?? null, projectId, intentId);
      if (recordDeadEnd) {
        const descRow = this.get("SELECT description FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
        const desc = String(descRow?.description ?? "");
        const hash = routeHash(desc);
        this.run("INSERT OR REPLACE INTO dead_ends (route_hash, project_id, intent_id, description, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          hash, projectId, intentId, desc, reason, ts);
      }
      if (!wasDone) {
        this.bumpStep(projectId);
        this.bumpStagnation(projectId);
      }
      this.logEvent(projectId, "intent.failed", { intentId, reason, recordDeadEnd, killedBy, wasDone });
    });
  }

  isDeadEnd(projectId: ProjectId, description: string): boolean {
    const hash = routeHash(description);
    const row = this.get("SELECT 1 FROM dead_ends WHERE project_id = ? AND route_hash = ?", projectId, hash);
    return !!row;
  }

  sweepExpiredLeases(): number {
    return this.transaction(() => {
      const nowIso = now();
      let swept = 0;
      const intents = this.all(
        "SELECT project_id, id, lease_epoch FROM intents WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
        nowIso,
      );
      for (const row of intents) {
        const result = this.run(
          `UPDATE intents
           SET status = 'open', lease_worker_id = NULL, lease_claimed_at = NULL, lease_expires_at = NULL
           WHERE project_id = ? AND id = ? AND status = 'claimed' AND lease_epoch = ?
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
          row.project_id,
          row.id,
          row.lease_epoch,
          nowIso,
        );
        if (result.changes !== 1) continue;
        swept += 1;
        this.logEvent(String(row.project_id), "intent.lease_expired", {
          intentId: String(row.id),
          epoch: Number(row.lease_epoch ?? 0),
        });
      }

      const runs = this.all(
        `SELECT project_id, id, owner_id, lease_epoch
         FROM subagent_runs
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        nowIso,
      );
      for (const row of runs) {
        const result = this.run(
          `UPDATE subagent_runs
           SET status = 'pending', owner_id = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
               lease_epoch = lease_epoch + 1
           WHERE project_id = ? AND id = ? AND status = 'running' AND lease_epoch = ?
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
          row.project_id,
          row.id,
          row.lease_epoch,
          nowIso,
        );
        if (result.changes !== 1) continue;
        swept += 1;
        this.logEvent(String(row.project_id), "run.lease_expired", {
          runId: String(row.id),
          ownerId: row.owner_id ? String(row.owner_id) : undefined,
          epoch: Number(row.lease_epoch ?? 0),
          nextEpoch: Number(row.lease_epoch ?? 0) + 1,
        });
      }
      return swept;
    });
  }

  createEndFact(projectId: ProjectId, description: string, fromFactIds: FactId[]): EndFact {
    return this.transaction(() => {
      const unfinished = this.get(
        "SELECT COUNT(*) AS count FROM intents WHERE project_id = ? AND status IN ('open', 'claimed')",
        projectId,
      );
      if (Number(unfinished?.count ?? 0) > 0) {
        throw new Error("cannot create end fact while intents are open or claimed");
      }
      const candidates = this.get(
        "SELECT COUNT(*) AS count FROM facts WHERE project_id = ? AND status = 'candidate'",
        projectId,
      );
      if (Number(candidates?.count ?? 0) > 0) {
        throw new Error("cannot create end fact while candidate facts await evaluation");
      }
      const unique = [...new Set(fromFactIds)];
      if (unique.length !== fromFactIds.length) throw new Error("end fact references must be unique");
      for (const factId of unique) {
        const fact = this.get("SELECT status FROM facts WHERE project_id = ? AND id = ?", projectId, factId);
        if (!fact || fact.status !== "pass") {
          throw new Error(`end fact may only reference pass facts: ${factId}`);
        }
      }
      this.run(
        "UPDATE end_facts SET status = 'superseded', superseded_at = ?, superseded_reason = ? WHERE project_id = ? AND status = 'active'",
        now(), "replaced by a newer planner proposal", projectId,
      );
      const id = `end_${String(this.nextId(projectId, "end_facts", "end_")).padStart(3, "0")}`;
      const createdAt = now();
      this.run(
        "INSERT INTO end_facts (id, project_id, description, from_fact_ids_json, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
        id, projectId, description, JSON.stringify(unique), createdAt,
      );
      this.run("UPDATE projects SET status = 'finish_proposed', updated_at = ? WHERE id = ?", createdAt, projectId);
      this.logEvent(projectId, "planner.end_fact_created", { endFactId: id, description, fromFactIds: unique });
      return { id, projectId, description, fromFactIds: unique, status: "active", createdAt };
    });
  }

  activeEndFact(projectId: ProjectId): EndFact | undefined {
    const row = this.get("SELECT * FROM end_facts WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", projectId);
    return row ? endFactFromRow(row) : undefined;
  }

  endFacts(projectId: ProjectId): EndFact[] {
    return this.all("SELECT * FROM end_facts WHERE project_id = ? ORDER BY created_at, id", projectId).map(endFactFromRow);
  }

  commitExplorerResult(
    projectId: ProjectId,
    intentId: IntentId,
    runId: RunId,
    input: FactInput,
    expected: IntentLeaseClaim,
    expectedRun?: RunLeaseClaim,
  ): Fact {
    return this.transaction(() => {
      const project = this.get("SELECT status FROM projects WHERE id = ?", projectId);
      if (!project || project.status !== "active") {
        throw new Error("explorer result cannot commit after project leaves active state");
      }
      const intent = this.get(
        "SELECT status, lease_worker_id, lease_epoch, lease_expires_at FROM intents WHERE project_id = ? AND id = ?",
        projectId,
        intentId,
      );
      const run = this.get("SELECT * FROM subagent_runs WHERE project_id = ? AND id = ?", projectId, runId);
      if (!intent || intent.status !== "claimed") throw new Error(`intent is not claimed: ${intentId}`);
      if (intent.lease_worker_id !== expected.workerId
        || Number(intent.lease_epoch) !== expected.epoch
        || String(intent.lease_expires_at ?? "") <= now()) {
        throw new Error(`stale or expired intent lease: ${intentId}`);
      }
      if (!run || run.status !== "running" || run.intent_id !== intentId) {
        throw new Error(`explorer run is not running for intent: ${runId}`);
      }
      this.assertRunClaimIfRequired(projectId, runFromRow(run), expectedRun);
      const fact = this.addFact(projectId, { ...input, parentIntentId: intentId });
      this.concludeIntent(projectId, intentId, fact.id);
      this.updateSubagentRun(projectId, runId, {
        status: "completed",
        factId: fact.id,
        outputSummary: fact.description.slice(0, 200),
      }, expectedRun);
      return fact;
    });
  }

  commitEvaluatorResult(
    projectId: ProjectId,
    factId: FactId,
    runId: RunId,
    verdict: Verdict,
    expectedRun?: RunLeaseClaim,
  ): void {
    this.transaction(() => {
      const project = this.get("SELECT status FROM projects WHERE id = ?", projectId);
      if (!project || project.status !== "active") {
        throw new Error("evaluator result cannot commit after project leaves active state");
      }
      const run = this.get("SELECT * FROM subagent_runs WHERE project_id = ? AND id = ?", projectId, runId);
      if (!run || run.status !== "running" || run.fact_id !== factId) {
        throw new Error(`evaluator run is not running for fact: ${runId}`);
      }
      this.assertRunClaimIfRequired(projectId, runFromRow(run), expectedRun);
      this.resolveFact(projectId, factId, verdict);
      this.updateSubagentRun(projectId, runId, {
        status: "completed",
        outputSummary: `${verdict.decision}: ${verdict.reason.slice(0, 150)}`,
      }, expectedRun);
    });
  }

  commitBroadcastAssessment(
    projectId: ProjectId,
    broadcastId: string,
    runId: RunId,
    assessment: BroadcastAssessment,
    broadcastKind?: string,
    expectedRun?: RunLeaseClaim,
  ): void {
    this.transaction(() => {
      const project = this.get("SELECT status FROM projects WHERE id = ?", projectId);
      if (!project || (project.status !== "active" && project.status !== "finish_proposed")) {
        throw new Error("broadcast result cannot commit after project stops");
      }
      const run = this.get(
        "SELECT * FROM subagent_runs WHERE project_id = ? AND id = ?",
        projectId,
        runId,
      );
      if (!run || run.status !== "running") {
        throw new Error(`broadcast evaluator run is not running: ${runId}`);
      }
      this.assertRunClaimIfRequired(projectId, runFromRow(run), expectedRun);
      if (assessment.decision === "condition_satisfied") {
        const fact = assessment.targetFactId
          ? this.get("SELECT status FROM facts WHERE project_id = ? AND id = ?", projectId, assessment.targetFactId)
          : undefined;
        if (!fact || fact.status !== "pending") {
          throw new Error(`broadcast target is not a pending fact: ${assessment.targetFactId ?? "missing"}`);
        }
        this.clearFactConditions(projectId, assessment.targetFactId!);
      } else if (assessment.decision === "relevant") {
        this.reactivateIfFinishProposed(projectId, "relevant federation broadcast");
      }
      this.logEvent(projectId, "federation.broadcast_assessed", {
        broadcastId,
        broadcastKind,
        runId,
        decision: assessment.decision,
        reason: assessment.reason,
        targetFactId: assessment.targetFactId,
      });
      this.updateSubagentRun(projectId, runId, {
        status: "completed",
        outputSummary: `${assessment.decision}: ${assessment.reason.slice(0, 150)}`,
      }, expectedRun);
    });
  }

  commitMetacogResult(
    projectId: ProjectId,
    runId: RunId,
    input: MetacogCommitInput,
    expectedRun?: RunLeaseClaim,
  ): void {
    this.transaction(() => {
      const project = this.get("SELECT status FROM projects WHERE id = ?", projectId);
      if (!project || (project.status !== "active" && project.status !== "finish_proposed")) {
        throw new Error("metacog result cannot commit after project stops");
      }
      const run = this.get(
        "SELECT * FROM subagent_runs WHERE project_id = ? AND id = ?",
        projectId,
        runId,
      );
      if (!run || run.status !== "running") {
        throw new Error(`metacog run is not running: ${runId}`);
      }
      this.assertRunClaimIfRequired(projectId, runFromRow(run), expectedRun);
      for (const hint of input.hints) this.addHint(projectId, hint);
      if (input.broadcast) {
        const createdAt = now();
        const inserted = this.run(
          `INSERT OR IGNORE INTO federation_outbox
           (event_id, project_id, scope, kind, source_fact_id, summary, confidence, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          input.broadcast.eventId,
          projectId,
          input.broadcast.scope,
          input.broadcast.kind,
          input.broadcast.sourceFactId ?? null,
          input.broadcast.summary,
          input.broadcast.confidence,
          createdAt,
        );
        if (inserted.changes > 0) {
          this.logEvent(projectId, "federation.outbox_enqueued", {
            eventId: input.broadcast.eventId,
            kind: input.broadcast.kind,
            sourceFactId: input.broadcast.sourceFactId,
          });
        }
      }
      this.updateSubagentRun(projectId, runId, {
        status: "completed",
        outputSummary: input.outputSummary,
      }, expectedRun);
      if (input.reviewedFactId) {
        this.logEvent(projectId, "metacog.fact_reviewed", {
          factId: input.reviewedFactId,
          outboxEventId: input.broadcast?.eventId,
        });
      }
      if (input.finalReviewCompleted && this.getProject(projectId)?.status === "finish_proposed") {
        this.logEvent(projectId, "metacog.final_review_completed", {
          runId,
          outboxEventId: input.broadcast?.eventId,
        });
      }
    });
  }

  federationOutbox(
    projectId: ProjectId,
    status?: FederationOutboxItem["status"],
  ): FederationOutboxItem[] {
    const rows = status
      ? this.all(
          "SELECT * FROM federation_outbox WHERE project_id = ? AND status = ? ORDER BY created_at, event_id",
          projectId,
          status,
        )
      : this.all(
          "SELECT * FROM federation_outbox WHERE project_id = ? ORDER BY created_at, event_id",
          projectId,
        );
    return rows.map(federationOutboxFromRow);
  }

  markFederationOutboxPublished(
    projectId: ProjectId,
    eventId: string,
    broadcastId: string,
    broadcastSeq: number,
  ): void {
    this.transaction(() => {
      const existing = this.get(
        "SELECT status FROM federation_outbox WHERE project_id = ? AND event_id = ?",
        projectId,
        eventId,
      );
      if (!existing) throw new Error(`federation outbox item not found: ${eventId}`);
      if (existing.status === "published") return;
      this.run(
        `UPDATE federation_outbox
         SET status = 'published', published_at = ?, broadcast_id = ?, broadcast_seq = ?
         WHERE project_id = ? AND event_id = ? AND status = 'pending'`,
        now(), broadcastId, broadcastSeq, projectId, eventId,
      );
      this.logEvent(projectId, "federation.outbox_published", {
        eventId,
        broadcastId,
        broadcastSeq,
      });
    });
  }

  // ─── Hint ───

  addHint(projectId: ProjectId, input: HintInput): Hint {
    return this.transaction(() => {
      this.reactivateIfFinishProposed(projectId, "hint.created");
      const counter = this.nextId(projectId, "hints", "h");
      const id = `h${String(counter).padStart(3, "0")}`;
      const ts = now();
      const hint: Hint = {
        id, projectId, content: input.content, creator: input.creator,
        kind: input.kind ?? "direction", targetIntentId: input.targetIntentId,
        createdAt: ts, expiresAt: input.expiresAt,
      };
      this.run("INSERT INTO hints (id, project_id, content, creator, kind, target_intent_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id, projectId, hint.content, hint.creator, hint.kind, input.targetIntentId ?? null, ts, input.expiresAt ?? null);
      this.logEvent(projectId, "hint.created", { hintId: id, creator: input.creator, kind: hint.kind });
      return hint;
    });
  }

  unconsumedHints(projectId: ProjectId): Hint[] {
    const nowIso = now();
    return this.all(
      "SELECT * FROM hints WHERE project_id = ? AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, id",
      projectId, nowIso,
    ).map(hintFromRow);
  }

  consumeHint(projectId: ProjectId, hintId: HintId): void {
    this.transaction(() => {
      const row = this.get("SELECT 1 FROM hints WHERE project_id = ? AND id = ?", projectId, hintId);
      if (!row) throw new Error(`hint not found: ${hintId}`);
      this.run("UPDATE hints SET consumed_at = ? WHERE project_id = ? AND id = ?", now(), projectId, hintId);
      this.logEvent(projectId, "hint.consumed", { hintId });
    });
  }

  // ─── Directive ───

  addDirective(projectId: ProjectId, input: DirectiveInput): Directive {
    return this.transaction(() => {
      const counter = this.nextId(projectId, "directives", "d");
      const id = `d${String(counter).padStart(3, "0")}`;
      const ts = now();
      const dir: Directive = { id, projectId, kind: input.kind, payload: input.payload, createdAt: ts };
      this.run("INSERT INTO directives (id, project_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        id, projectId, input.kind, input.payload, ts);
      this.logEvent(projectId, "directive.created", { directiveId: id, kind: input.kind });
      return dir;
    });
  }

  unconsumedDirectives(projectId: ProjectId): Directive[] {
    return this.all("SELECT * FROM directives WHERE project_id = ? AND consumed_at IS NULL ORDER BY created_at, id", projectId).map(directiveFromRow);
  }

  consumeDirective(projectId: ProjectId, directiveId: DirectiveId): void {
    this.transaction(() => {
      const row = this.get("SELECT 1 FROM directives WHERE project_id = ? AND id = ?", projectId, directiveId);
      if (!row) throw new Error(`directive not found: ${directiveId}`);
      this.run("UPDATE directives SET consumed_at = ? WHERE project_id = ? AND id = ?", now(), projectId, directiveId);
      this.logEvent(projectId, "directive.consumed", { directiveId });
    });
  }

  // ─── SubagentRun ───

  createSubagentRun(projectId: ProjectId, input: SubagentRunInput): SubagentRun {
    return this.transaction(() => {
      const id = newRunId();
      const ts = now();
      const inserted = this.run(
        `INSERT OR IGNORE INTO subagent_runs
         (id, project_id, profile_id, role, worker_name, status, dispatch_key, intent_id, fact_id,
          parent_run_id, input_summary, attempt, lease_epoch, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, 0, ?)`,
        id, projectId, input.profileId, input.role, input.workerName,
        input.dispatchKey ?? null,
        input.intentId ?? null, input.factId ?? null,
        input.parentRunId ?? null, input.inputSummary ?? null,
        ts,
      );
      if (inserted.changes !== 1 && input.dispatchKey) {
        const active = this.get(
          `SELECT * FROM subagent_runs
           WHERE project_id = ? AND dispatch_key = ? AND status IN ('pending', 'running')`,
          projectId,
          input.dispatchKey,
        );
        if (active) return runFromRow(active);
      }
      const run = this.get("SELECT * FROM subagent_runs WHERE project_id = ? AND id = ?", projectId, id);
      if (!run) throw new Error(`failed to read back subagent run: ${id}`);
      const parsed = runFromRow(run);
      this.logEvent(projectId, "run.created", {
        runId: id, profileId: input.profileId, role: input.role,
        intentId: input.intentId,
        dispatchKey: input.dispatchKey,
      });
      return parsed;
    });
  }

  claimSubagentRun(
    projectId: ProjectId,
    runId: RunId,
    ownerId: string,
    leaseMs: number,
  ): RunLeaseClaim | undefined {
    return this.transaction(() => {
      const heartbeatAt = now();
      const result = this.run(
        `UPDATE subagent_runs
         SET status = 'running', owner_id = ?, attempt = attempt + 1,
             lease_epoch = lease_epoch + 1, heartbeat_at = ?, lease_expires_at = ?,
             started_at = COALESCE(started_at, ?), finished_at = NULL
         WHERE project_id = ? AND id = ? AND status = 'pending'`,
        ownerId,
        heartbeatAt,
        new Date(Date.now() + leaseMs).toISOString(),
        heartbeatAt,
        projectId,
        runId,
      );
      if (result.changes !== 1) {
        const row = this.get("SELECT status FROM subagent_runs WHERE project_id = ? AND id = ?", projectId, runId);
        if (!row) throw new Error(`subagent run not found: ${runId}`);
        return undefined;
      }
      const row = this.get(
        "SELECT attempt, lease_epoch FROM subagent_runs WHERE project_id = ? AND id = ?",
        projectId,
        runId,
      )!;
      const claim = {
        ownerId,
        epoch: Number(row.lease_epoch),
        attempt: Number(row.attempt),
      };
      this.logEvent(projectId, "run.claimed", { runId, ...claim });
      return claim;
    });
  }

  heartbeatSubagentRun(
    projectId: ProjectId,
    runId: RunId,
    expected: RunLeaseClaim,
    leaseMs: number,
  ): void {
    const heartbeatAt = now();
    const result = this.run(
      `UPDATE subagent_runs
       SET heartbeat_at = ?, lease_expires_at = ?
       WHERE project_id = ? AND id = ? AND status = 'running'
         AND owner_id = ? AND lease_epoch = ? AND attempt = ?
         AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
      heartbeatAt,
      new Date(Date.now() + leaseMs).toISOString(),
      projectId,
      runId,
      expected.ownerId,
      expected.epoch,
      expected.attempt,
      heartbeatAt,
    );
    if (result.changes !== 1) throw new Error(`stale or expired subagent run lease: ${runId}`);
  }

  assertSubagentRunClaim(projectId: ProjectId, runId: RunId, expected: RunLeaseClaim): void {
    const row = this.get(
      `SELECT 1 FROM subagent_runs
       WHERE project_id = ? AND id = ? AND status = 'running'
         AND owner_id = ? AND lease_epoch = ? AND attempt = ?
         AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
      projectId,
      runId,
      expected.ownerId,
      expected.epoch,
      expected.attempt,
      now(),
    );
    if (!row) throw new Error(`stale or expired subagent run lease: ${runId}`);
  }

  updateSubagentRun(
    projectId: ProjectId,
    runId: RunId,
    patch: Partial<Pick<SubagentRun,
      "status" | "outputSummary" | "errorMessage" | "factId" | "startedAt" | "finishedAt"
      | "usedConclude" | "inputTokens" | "outputTokens"
      | "promptHash" | "promptManifest" | "contextArtifact" | "outputArtifact" | "workerSessionId">>,
    expected?: RunLeaseClaim,
  ): void {
    this.transaction(() => {
      const existing = this.get("SELECT * FROM subagent_runs WHERE project_id = ? AND id = ?", projectId, runId);
      if (!existing) throw new Error(`subagent run not found: ${runId}`);
      if (expected) this.assertSubagentRunClaim(projectId, runId, expected);
      const prevStatus = String(existing.status);
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
      if (patch.outputSummary !== undefined) { sets.push("output_summary = ?"); params.push(patch.outputSummary); }
      if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); params.push(patch.errorMessage); }
      if (patch.factId !== undefined) { sets.push("fact_id = ?"); params.push(patch.factId); }
      if (patch.usedConclude !== undefined) { sets.push("used_conclude = ?"); params.push(patch.usedConclude ? 1 : 0); }
      if (patch.inputTokens !== undefined) { sets.push("input_tokens = ?"); params.push(patch.inputTokens); }
      if (patch.outputTokens !== undefined) { sets.push("output_tokens = ?"); params.push(patch.outputTokens); }
      if (patch.promptHash !== undefined) { sets.push("prompt_hash = ?"); params.push(patch.promptHash); }
      if (patch.promptManifest !== undefined) {
        sets.push("prompt_manifest_json = ?");
        params.push(JSON.stringify(patch.promptManifest));
      }
      if (patch.contextArtifact !== undefined) {
        sets.push("context_artifact_json = ?");
        params.push(JSON.stringify(patch.contextArtifact));
      }
      if (patch.outputArtifact !== undefined) {
        sets.push("output_artifact_json = ?");
        params.push(JSON.stringify(patch.outputArtifact));
      }
      if (patch.workerSessionId !== undefined) { sets.push("worker_session_id = ?"); params.push(patch.workerSessionId); }
      if (patch.startedAt !== undefined) { sets.push("started_at = ?"); params.push(patch.startedAt); }
      if (patch.finishedAt !== undefined) { sets.push("finished_at = ?"); params.push(patch.finishedAt); }

      const wantRunning = patch.status === "running";
      const wantTerminal = patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled"
        || patch.status === "abandoned" || patch.status === "discarded";
      if (wantRunning) { sets.push("started_at = COALESCE(started_at, ?)"); params.push(now()); }
      if (wantTerminal) {
        sets.push("finished_at = COALESCE(finished_at, ?)"); params.push(now());
        sets.push("owner_id = NULL", "heartbeat_at = NULL", "lease_expires_at = NULL");
        if (!expected && existing.owner_id) sets.push("lease_epoch = lease_epoch + 1");
      }

      if (sets.length === 0) return;
      params.push(projectId, runId);
      this.run(`UPDATE subagent_runs SET ${sets.join(", ")} WHERE project_id = ? AND id = ?`, ...params);
      this.logEvent(projectId, "run.updated", {
        runId, prevStatus: prevStatus,
        status: patch.status, outputSummary: patch.outputSummary, errorMessage: patch.errorMessage,
      });
    });
  }

  getSubagentRun(projectId: ProjectId, runId: RunId): SubagentRun | undefined {
    const row = this.get("SELECT * FROM subagent_runs WHERE project_id = ? AND id = ?", projectId, runId);
    return row ? runFromRow(row) : undefined;
  }

  subagentRuns(projectId: ProjectId, filter?: { profileId?: string; status?: RunStatus }): SubagentRun[] {
    let sql = "SELECT * FROM subagent_runs WHERE project_id = ?";
    const params: unknown[] = [projectId];
    if (filter?.profileId) { sql += " AND profile_id = ?"; params.push(filter.profileId); }
    if (filter?.status) { sql += " AND status = ?"; params.push(filter.status); }
    sql += " ORDER BY created_at, id";
    return this.all(sql, ...params).map(runFromRow);
  }

  // ─── Event ───

  logEvent(projectId: ProjectId, type: string, payload: Record<string, unknown> = {}): GraphEvent {
    const ts = now();
    const result = this.run(
      "INSERT INTO events (project_id, type, payload_json, timestamp) VALUES (?, ?, ?, ?)",
      projectId, type, JSON.stringify(payload), ts,
    );
    return { seq: Number(result.lastInsertRowid), projectId, type, payload, timestamp: ts };
  }

  events(projectId: ProjectId, sinceSeq?: number, limit = 1000): GraphEvent[] {
    if (sinceSeq !== undefined) {
      return this.all(
        "SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        projectId,
        sinceSeq,
        limit,
      ).map(eventFromRow);
    }
    return this.all(
      "SELECT * FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT ?",
      projectId,
      limit,
    ).reverse().map(eventFromRow);
  }

  // ─── Progress ───

  progress(projectId: ProjectId): Progress {
    const facts = this.all("SELECT status FROM facts WHERE project_id = ?", projectId);
    const intents = this.all("SELECT status FROM intents WHERE project_id = ?", projectId);
    const evRow = this.get("SELECT timestamp FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT 1", projectId);
    const stepsRow = this.get("SELECT value FROM meta WHERE key = ?", `steps:${projectId}`);
    const stagnationRow = this.get("SELECT value FROM meta WHERE key = ?", `stagnation:${projectId}`);
    return {
      totalFacts: facts.length,
      passFacts: facts.filter((f) => f.status === "pass").length,
      candidateFacts: facts.filter((f) => f.status === "candidate").length,
      pendingFacts: facts.filter((f) => f.status === "pending").length,
      denyFacts: facts.filter((f) => f.status === "deny").length,
      openIntents: intents.filter((i) => i.status === "open").length,
      claimedIntents: intents.filter((i) => i.status === "claimed").length,
      stepsExecuted: Number(stepsRow?.value ?? 0),
      lastActivityAt: String(evRow?.timestamp ?? now()),
      stagnationLevel: Number(stagnationRow?.value ?? 0),
    };
  }

  // ─── Transaction ───

  transaction<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  // ─── Internals ───

  private run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }

  private get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    return this.db.prepare(sql).get(...params);
  }

  private all(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
    return this.db.prepare(sql).all(...params);
  }

  private nextId(projectId: ProjectId, table: string, prefix: string): number {
    const row = this.get(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`, projectId);
    return Number(row?.count ?? 0) + 1;
  }

  private loadIntentSources(projectId: ProjectId, intentId: IntentId): string[] {
    return this.all("SELECT fact_id FROM intent_sets WHERE project_id = ? AND intent_id = ? ORDER BY ordinal", projectId, intentId)
      .map((r) => String(r.fact_id));
  }

  private bumpStep(projectId: ProjectId): void {
    this.run("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)", `steps:${projectId}`);
  }

  private bumpStagnation(projectId: ProjectId): void {
    this.run("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)", `stagnation:${projectId}`);
  }

  private reactivateIfFinishProposed(projectId: ProjectId, cause: string): void {
    const project = this.get("SELECT status FROM projects WHERE id = ?", projectId);
    if (!project || project.status !== "finish_proposed") return;
    this.run("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?", now(), projectId);
    this.run(
      "UPDATE end_facts SET status = 'superseded', superseded_at = ?, superseded_reason = ? WHERE project_id = ? AND status = 'active'",
      now(), cause, projectId,
    );
    this.logEvent(projectId, "project.finish_superseded", { cause });
  }

  private assertRunClaimIfRequired(
    projectId: ProjectId,
    run: SubagentRun,
    expected?: RunLeaseClaim,
  ): void {
    if (run.ownerId || expected) {
      if (!expected) throw new Error(`subagent run lease required: ${run.id}`);
      this.assertSubagentRunClaim(projectId, run.id, expected);
    }
  }

  private findProject(idOrSession: string): Project | undefined {
    const row = this.get("SELECT * FROM projects WHERE id = ? OR session = ?", idOrSession, idOrSession);
    return row ? projectFromRow(row) : undefined;
  }
}

function assertDatabaseIdentity(db: DatabaseSync, applicationId: number, label: string): void {
  const tableCount = Number((db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).get() as { count: number }).count);
  if (tableCount === 0) return;
  const row = db.prepare("PRAGMA application_id").get() as { application_id: number };
  if (Number(row.application_id) !== applicationId) {
    throw new Error(`${label} database does not use the first-version schema`);
  }
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (Number(version.user_version) !== 1) {
    throw new Error(`${label} database schema version must be 1`);
  }
}

// ─── Row mappers ───

function projectFromRow(row: Record<string, unknown>): Project {
  return {
    id: String(row.id), session: String(row.session), name: String(row.name),
    target: String(row.target), goal: String(row.goal),
    status: String(row.status) as Project["status"], worker: String(row.worker),
    sessionDir: String(row.session_dir),
    workspaceDir: String(row.workspace_dir ?? row.session_dir),
    configPath: String(row.config_path),
    taskConfig: JSON.parse(String(row.config_json)) as TaskConfig,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function factFromRow(row: Record<string, unknown>): Fact {
  return {
    id: String(row.id), projectId: String(row.project_id),
    description: String(row.description),
    evidence: JSON.parse(String(row.evidence_json ?? "[]")),
    source: String(row.source) as Fact["source"],
    confidence: Number(row.confidence), status: String(row.status) as FactStatus,
    parentIntentId: row.parent_intent_id ? String(row.parent_intent_id) : undefined,
    reviewerReason: row.reviewer_reason ? String(row.reviewer_reason) : undefined,
    requiredConditions: JSON.parse(String(row.required_conditions_json ?? "[]")),
    stepDiscovered: row.step_discovered !== undefined && row.step_discovered !== null ? Number(row.step_discovered) : undefined,
    createdAt: String(row.created_at),
  };
}

function endFactFromRow(row: Record<string, unknown>): EndFact {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    description: String(row.description),
    fromFactIds: JSON.parse(String(row.from_fact_ids_json ?? "[]")),
    status: String(row.status) as EndFact["status"],
    createdAt: String(row.created_at),
    supersededAt: row.superseded_at ? String(row.superseded_at) : undefined,
    supersededReason: row.superseded_reason ? String(row.superseded_reason) : undefined,
  };
}

function intentFromRow(row: Record<string, unknown>, sources: string[]): Intent {
  return {
    id: String(row.id), projectId: String(row.project_id),
    description: String(row.description), creator: String(row.creator) as Intent["creator"],
    parentFactIds: sources,
    status: String(row.status) as IntentStatus,
    dispatchRequested: Number(row.dispatch_requested) !== 0,
    parentIntentId: row.parent_intent_id ? String(row.parent_intent_id) : undefined,
    leaseEpoch: Number(row.lease_epoch),
    lease: row.lease_worker_id ? {
      workerId: String(row.lease_worker_id),
      epoch: Number(row.lease_epoch),
      claimedAt: String(row.lease_claimed_at),
      expiresAt: String(row.lease_expires_at),
    } : undefined,
    priority: Number(row.priority),
    createdAt: String(row.created_at),
    concludedAt: row.concluded_at ? String(row.concluded_at) : undefined,
    concludedFactId: row.concluded_fact_id ? String(row.concluded_fact_id) : undefined,
    failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
    killedBy: row.killed_by ? String(row.killed_by) as Intent["killedBy"] : undefined,
  };
}

function hintFromRow(row: Record<string, unknown>): Hint {
  return {
    id: String(row.id), projectId: String(row.project_id),
    content: String(row.content), creator: String(row.creator) as Hint["creator"],
    kind: String(row.kind) as Hint["kind"],
    targetIntentId: row.target_intent_id ? String(row.target_intent_id) : undefined,
    consumedAt: row.consumed_at ? String(row.consumed_at) : undefined,
    createdAt: String(row.created_at),
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
  };
}

function directiveFromRow(row: Record<string, unknown>): Directive {
  return {
    id: String(row.id), projectId: String(row.project_id),
    kind: String(row.kind) as Directive["kind"], payload: String(row.payload),
    consumedAt: row.consumed_at ? String(row.consumed_at) : undefined,
    createdAt: String(row.created_at),
  };
}

function eventFromRow(row: Record<string, unknown>): GraphEvent {
  return {
    seq: Number(row.seq), projectId: String(row.project_id),
    type: String(row.type),
    payload: JSON.parse(String(row.payload_json ?? "{}")),
    timestamp: String(row.timestamp),
  };
}

function runFromRow(row: Record<string, unknown>): SubagentRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    profileId: String(row.profile_id),
    role: String(row.role) as SubagentRun["role"],
    workerName: String(row.worker_name),
    status: String(row.status) as SubagentRun["status"],
    dispatchKey: row.dispatch_key ? String(row.dispatch_key) : undefined,
    ownerId: row.owner_id ? String(row.owner_id) : undefined,
    attempt: Number(row.attempt ?? 0),
    leaseEpoch: Number(row.lease_epoch ?? 0),
    heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : undefined,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
    intentId: row.intent_id ? String(row.intent_id) : undefined,
    factId: row.fact_id ? String(row.fact_id) : undefined,
    parentRunId: row.parent_run_id ? String(row.parent_run_id) : undefined,
    inputSummary: row.input_summary ? String(row.input_summary) : undefined,
    outputSummary: row.output_summary ? String(row.output_summary) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    usedConclude: row.used_conclude !== undefined && row.used_conclude !== null ? Boolean(row.used_conclude) : undefined,
    inputTokens: row.input_tokens !== undefined && row.input_tokens !== null ? Number(row.input_tokens) : undefined,
    outputTokens: row.output_tokens !== undefined && row.output_tokens !== null ? Number(row.output_tokens) : undefined,
    promptHash: row.prompt_hash ? String(row.prompt_hash) : undefined,
    promptManifest: row.prompt_manifest_json
      ? JSON.parse(String(row.prompt_manifest_json)) as SubagentRun["promptManifest"]
      : undefined,
    contextArtifact: row.context_artifact_json
      ? JSON.parse(String(row.context_artifact_json)) as SubagentRun["contextArtifact"]
      : undefined,
    outputArtifact: row.output_artifact_json
      ? JSON.parse(String(row.output_artifact_json)) as SubagentRun["outputArtifact"]
      : undefined,
    workerSessionId: row.worker_session_id ? String(row.worker_session_id) : undefined,
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
  };
}

function federationOutboxFromRow(row: Record<string, unknown>): FederationOutboxItem {
  return {
    eventId: String(row.event_id),
    projectId: String(row.project_id),
    scope: String(row.scope),
    kind: String(row.kind) as FederationOutboxItem["kind"],
    sourceFactId: row.source_fact_id ? String(row.source_fact_id) : undefined,
    summary: String(row.summary),
    confidence: Number(row.confidence),
    status: String(row.status) as FederationOutboxItem["status"],
    createdAt: String(row.created_at),
    publishedAt: row.published_at ? String(row.published_at) : undefined,
    broadcastId: row.broadcast_id ? String(row.broadcast_id) : undefined,
    broadcastSeq: row.broadcast_seq !== null && row.broadcast_seq !== undefined
      ? Number(row.broadcast_seq)
      : undefined,
  };
}
