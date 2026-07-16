/** Durable, scoped cross-session Fact broadcast store. */
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectId } from "../agent/types.js";

export type InsightKind = "fact" | "dead_end" | "pending" | "condition_met" | "session_summary";
export type DeliveryStatus = "pending" | "evaluated" | "irrelevant" | "failed";
export type TaskGroupStatus = "running" | "completed";
export type TaskGroupMemberStatus = "expected" | "active" | "left" | "completed";

export interface GlobalInsightRef {
  sessionId: string;
  projectId: ProjectId;
  factId?: string;
}

export interface GlobalInsight {
  id: string;
  seq: number;
  scope: string;
  kind: InsightKind;
  source: GlobalInsightRef;
  summary: string;
  confidence: number;
  requiredConditions?: string[];
  publishedAt: number;
}

export type GlobalInsightListener = (insight: GlobalInsight) => void;

export interface FederationBusOptions {
  dbPath: string;
}

export interface TaskGroupState {
  scope: string;
  generation: number;
  status: TaskGroupStatus;
  headSeq: number;
  pendingDeliveries: number;
  members: Array<{
    sessionId: string;
    projectId?: string;
    status: TaskGroupMemberStatus;
    finishReady: boolean;
    completed: boolean;
    cursor: number;
  }>;
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA application_id=1346784050;
PRAGMA user_version=1;
CREATE TABLE IF NOT EXISTS federation_groups (
  scope TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS federation_group_members (
  scope TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, session_id),
  FOREIGN KEY (scope) REFERENCES federation_groups(scope) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_federation_group_members_session
  ON federation_group_members(session_id);
CREATE TABLE IF NOT EXISTS federation_sessions (
  session_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_id TEXT,
  finish_ready INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS federation_insights (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_session TEXT NOT NULL,
  source_project TEXT NOT NULL,
  source_fact TEXT,
  summary TEXT NOT NULL,
  confidence REAL NOT NULL,
  required_conditions_json TEXT NOT NULL DEFAULT '[]',
  published_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_federation_insights_scope_seq
  ON federation_insights(scope, seq);
CREATE TABLE IF NOT EXISTS federation_deliveries (
  insight_id TEXT NOT NULL,
  target_session TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  evaluated_agent_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (insight_id, target_session),
  FOREIGN KEY (insight_id) REFERENCES federation_insights(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_federation_deliveries_target_status
  ON federation_deliveries(target_session, status);
CREATE TABLE IF NOT EXISTS federation_cursors (
  session_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

export class FederationBus {
  private readonly emitter = new EventEmitter();
  private readonly db: DatabaseSync;
  private fallbackCounter = 0;

  constructor(options: FederationBusOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    try {
      assertDatabaseIdentity(this.db, 1346784050, "peak federation");
      this.db.exec("PRAGMA foreign_keys=ON");
      this.db.exec(SCHEMA);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.emitter.setMaxListeners(100);
  }

  close(): void {
    this.db.close();
  }

  registerExpectedSessions(scope: string, sessionIds: string[]): void {
    const members = [...new Set(sessionIds)].sort();
    if (!scope || members.length === 0 || members.some((sessionId) => !sessionId)) {
      throw new Error("task group requires a scope and at least one non-empty session id");
    }
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let group = this.groupRow(scope);
      if (!group) {
        this.db.prepare(
          "INSERT INTO federation_groups (scope, generation, status, updated_at) VALUES (?, 1, 'running', ?)",
        ).run(scope, now);
        group = { generation: 1, status: "running" };
      }

      const existing = this.db.prepare(
        "SELECT session_id FROM federation_group_members WHERE scope = ? ORDER BY session_id",
      ).all(scope).map((row) => String((row as { session_id: string }).session_id));
      if (existing.length > 0 && JSON.stringify(existing) !== JSON.stringify(members)) {
        throw new Error(
          `task group membership mismatch for ${scope}: expected [${existing.join(", ")}], received [${members.join(", ")}]`,
        );
      }

      for (const sessionId of members) {
        const other = this.db.prepare(
          `SELECT scope FROM federation_group_members
           WHERE session_id = ? AND scope <> ? AND status IN ('expected', 'active') LIMIT 1`,
        ).get(sessionId, scope) as { scope: string } | undefined;
        if (other) throw new Error(`session ${sessionId} already belongs to running task group ${other.scope}`);
        this.db.prepare(
          `INSERT OR IGNORE INTO federation_group_members
           (scope, session_id, generation, status, registered_at, updated_at)
           VALUES (?, ?, ?, 'expected', ?, ?)`,
        ).run(scope, sessionId, group.generation, now, now);
        this.ensureCursor(sessionId, scope, now);
        this.db.prepare(
          `INSERT OR IGNORE INTO federation_deliveries (insight_id, target_session, status, updated_at)
           SELECT id, ?, 'pending', ? FROM federation_insights
           WHERE scope = ? AND source_session <> ?`,
        ).run(sessionId, now, scope, sessionId);
        this.refreshCursor(sessionId, scope);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  registerSession(sessionId: string, scope = "default", projectId?: string): void {
    if (!sessionId || !scope) throw new Error("federation session and scope must be non-empty");
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousScope = this.sessionScope(sessionId);
      if (previousScope && previousScope !== scope) {
        const previousGroup = this.groupRow(previousScope);
        if (previousGroup?.status === "running") {
          const generation = this.bumpGeneration(previousScope, now);
          this.db.prepare(
            `UPDATE federation_group_members SET generation = ?, status = 'left', updated_at = ?
             WHERE scope = ? AND session_id = ?`,
          ).run(generation, now, previousScope, sessionId);
        }
        this.db.prepare("DELETE FROM federation_cursors WHERE session_id = ?").run(sessionId);
        this.db.prepare("DELETE FROM federation_sessions WHERE session_id = ?").run(sessionId);
      }

      let group = this.groupRow(scope);
      if (!group) {
        this.db.prepare(
          "INSERT INTO federation_groups (scope, generation, status, updated_at) VALUES (?, 1, 'running', ?)",
        ).run(scope, now);
        group = { generation: 1, status: "running" };
      }
      let member = this.memberRow(scope, sessionId);
      if (group.status === "completed") {
        if (member?.status !== "completed") {
          throw new Error(`federation scope is already completed: ${scope}`);
        }
      } else if (!member || member.status === "left") {
        const hasMembers = Boolean(this.db.prepare(
          "SELECT 1 AS found FROM federation_group_members WHERE scope = ? LIMIT 1",
        ).get(scope));
        if (hasMembers) group = { generation: this.bumpGeneration(scope, now), status: "running" };
        this.db.prepare(
          `INSERT INTO federation_group_members
           (scope, session_id, generation, status, registered_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)
           ON CONFLICT(scope, session_id) DO UPDATE SET
             generation = excluded.generation, status = 'active', updated_at = excluded.updated_at`,
        ).run(scope, sessionId, group.generation, now, now);
        member = { generation: group.generation, status: "active" };
      } else if (member.status === "expected") {
        this.db.prepare(
          "UPDATE federation_group_members SET status = 'active', updated_at = ? WHERE scope = ? AND session_id = ?",
        ).run(now, scope, sessionId);
        member = { ...member, status: "active" };
      }
      if (projectId) {
        this.db.prepare(
          "UPDATE federation_group_members SET project_id = ?, updated_at = ? WHERE scope = ? AND session_id = ?",
        ).run(projectId, now, scope, sessionId);
      }

      const terminal = member?.status === "completed";
      this.db.prepare(
        `INSERT INTO federation_sessions
         (session_id, scope, project_id, finish_ready, completed, registered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           scope = excluded.scope,
           project_id = COALESCE(excluded.project_id, federation_sessions.project_id),
           finish_ready = CASE WHEN federation_sessions.scope = excluded.scope THEN federation_sessions.finish_ready ELSE excluded.finish_ready END,
           completed = CASE WHEN federation_sessions.scope = excluded.scope THEN federation_sessions.completed ELSE excluded.completed END,
           updated_at = excluded.updated_at`,
      ).run(sessionId, scope, projectId ?? null, terminal ? 1 : 0, terminal ? 1 : 0, now, now);
      this.ensureCursor(sessionId, scope, now);
      if (!terminal) {
        this.db.prepare(
          `INSERT OR IGNORE INTO federation_deliveries (insight_id, target_session, status, updated_at)
           SELECT id, ?, 'pending', ? FROM federation_insights
           WHERE scope = ? AND source_session <> ?`,
        ).run(sessionId, now, scope, sessionId);
        this.refreshCursor(sessionId, scope);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setSessionFinishReady(sessionId: string, projectId: string, ready: boolean): void {
    const result = this.db.prepare(
      `UPDATE federation_sessions
       SET project_id = ?, finish_ready = ?, completed = CASE WHEN ? = 0 THEN 0 ELSE completed END,
           updated_at = ?
       WHERE session_id = ? AND EXISTS (
         SELECT 1 FROM federation_group_members m
         WHERE m.session_id = federation_sessions.session_id
           AND m.scope = federation_sessions.scope
           AND m.status IN ('active', 'completed')
       )`,
    ).run(projectId, ready ? 1 : 0, ready ? 1 : 0, Date.now(), sessionId);
    if (result.changes !== 1) throw new Error(`federation session not registered: ${sessionId}`);
  }

  markSessionCompleted(sessionId: string): void {
    const result = this.db.prepare(
      `UPDATE federation_sessions
       SET finish_ready = 1, completed = 1, updated_at = ?
       WHERE session_id = ?`,
    ).run(Date.now(), sessionId);
    if (result.changes !== 1) throw new Error(`federation session not registered: ${sessionId}`);
  }

  allSessionsFinishReady(scope: string): boolean {
    const group = this.groupRow(scope);
    if (group?.status === "completed") return true;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN m.status = 'active' AND s.finish_ready = 1 THEN 1 ELSE 0 END) AS ready
       FROM federation_group_members m
       LEFT JOIN federation_sessions s ON s.session_id = m.session_id AND s.scope = m.scope
       WHERE m.scope = ? AND m.generation = ?`,
    ).get(scope, group?.generation ?? 0) as { total: number; ready: number | null };
    return Number(row.total) > 0 && Number(row.ready ?? 0) === Number(row.total);
  }

  /**
   * Atomically closes a task-group scope only when every registered session has
   * persisted finish readiness and the durable broadcast queue is quiescent.
   * BEGIN IMMEDIATE serializes this check with publishInsight(), eliminating
   * the check-then-publish race in the supervisor.
   */
  tryCompleteScope(scope: string, expectedGeneration?: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const group = this.groupRow(scope);
      if (!group || (expectedGeneration !== undefined && group.generation !== expectedGeneration)) {
        this.db.exec("COMMIT");
        return false;
      }
      if (group.status === "completed") {
        this.db.exec("COMMIT");
        return true;
      }
      const sessions = this.db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN m.status = 'active' AND s.finish_ready = 1 THEN 1 ELSE 0 END) AS ready
         FROM federation_group_members m
         LEFT JOIN federation_sessions s ON s.session_id = m.session_id AND s.scope = m.scope
         WHERE m.scope = ? AND m.generation = ?`,
      ).get(scope, group.generation) as { total: number; ready: number | null };
      const total = Number(sessions.total);
      if (total === 0 || Number(sessions.ready ?? 0) !== total) {
        this.db.exec("COMMIT");
        return false;
      }

      const pending = this.db.prepare(
        `SELECT COUNT(*) AS count FROM federation_deliveries d
         JOIN federation_insights i ON i.id = d.insight_id
         WHERE i.scope = ? AND d.status IN ('pending', 'failed')`,
      ).get(scope) as { count: number };
      if (Number(pending.count) > 0) {
        this.db.exec("COMMIT");
        return false;
      }

      const head = this.headSeq(scope);
      const lagging = this.db.prepare(
         `SELECT COUNT(*) AS count FROM federation_group_members m
          LEFT JOIN federation_cursors c ON c.session_id = m.session_id AND c.scope = m.scope
          WHERE m.scope = ? AND m.generation = ? AND COALESCE(c.last_seq, 0) < ?`,
      ).get(scope, group.generation, head) as { count: number };
      if (Number(lagging.count) > 0) {
        this.db.exec("COMMIT");
        return false;
      }

      this.db.prepare(
        "UPDATE federation_sessions SET completed = 1, updated_at = ? WHERE scope = ?",
      ).run(Date.now(), scope);
      this.db.prepare(
        "UPDATE federation_group_members SET status = 'completed', updated_at = ? WHERE scope = ? AND generation = ?",
      ).run(Date.now(), scope, group.generation);
      this.db.prepare(
        "UPDATE federation_groups SET status = 'completed', updated_at = ? WHERE scope = ? AND generation = ?",
      ).run(Date.now(), scope, group.generation);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  registeredSessions(scope: string): Array<{
    sessionId: string;
    projectId?: string;
    finishReady: boolean;
    completed: boolean;
    generation: number;
    memberStatus: TaskGroupMemberStatus;
  }> {
    const rows = this.db.prepare(
      `SELECT m.session_id, m.generation, m.status,
              COALESCE(m.project_id, s.project_id) AS project_id,
              s.finish_ready, s.completed
       FROM federation_group_members m
       LEFT JOIN federation_sessions s ON s.session_id = m.session_id AND s.scope = m.scope
       WHERE m.scope = ? ORDER BY m.session_id`,
    ).all(scope) as Array<{
      session_id: string;
      project_id: string | null;
      finish_ready: number;
      completed: number;
      generation: number;
      status: TaskGroupMemberStatus;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      projectId: row.project_id ?? undefined,
      finishReady: Boolean(row.finish_ready),
      completed: row.status === "completed" || Boolean(row.completed),
      generation: Number(row.generation),
      memberStatus: row.status,
    }));
  }

  unregisterSession(sessionId: string): void {
    const scope = this.sessionScope(sessionId);
    if (!scope) return;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const group = this.groupRow(scope);
      if (group?.status === "running") {
        const generation = this.bumpGeneration(scope, now);
        this.db.prepare(
          `UPDATE federation_group_members SET generation = ?, status = 'left', updated_at = ?
           WHERE scope = ? AND session_id = ?`,
        ).run(generation, now, scope, sessionId);
      }
      this.db.prepare("DELETE FROM federation_cursors WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM federation_sessions WHERE session_id = ?").run(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  groupGeneration(scope: string): number | undefined {
    return this.groupRow(scope)?.generation;
  }

  taskGroup(scope: string): TaskGroupState | undefined {
    const group = this.groupRow(scope);
    if (!group) return undefined;
    const headSeq = this.headSeq(scope);
    return {
      scope,
      generation: group.generation,
      status: group.status,
      headSeq,
      pendingDeliveries: this.pendingDeliveryCount(scope),
      members: this.registeredSessions(scope).map((member) => ({
        sessionId: member.sessionId,
        projectId: member.projectId,
        status: member.memberStatus,
        finishReady: member.finishReady,
        completed: member.completed,
        cursor: this.cursorForScope(member.sessionId, scope),
      })),
    };
  }

  taskGroups(): TaskGroupState[] {
    const rows = this.db.prepare(
      "SELECT scope FROM federation_groups ORDER BY scope",
    ).all() as Array<{ scope: string }>;
    return rows.flatMap((row) => {
      const group = this.taskGroup(row.scope);
      return group ? [group] : [];
    });
  }

  publishInsight(
    kind: InsightKind,
    source: GlobalInsightRef,
    summary: string,
    confidence: number,
    requiredConditions?: string[],
    options: { id?: string; scope?: string } = {},
  ): GlobalInsight {
    const id = options.id ?? `gi_${Date.now().toString(36)}_${++this.fallbackCounter}`;
    const scope = options.scope ?? this.sessionScope(source.sessionId) ?? "default";
    const publishedAt = Date.now();
    const existing = this.getInsight(id);
    if (existing && (
      existing.scope !== scope
      || existing.kind !== kind
      || existing.source.sessionId !== source.sessionId
      || existing.source.projectId !== source.projectId
      || existing.source.factId !== source.factId
      || existing.summary !== summary
      || existing.confidence !== confidence
      || JSON.stringify(existing.requiredConditions ?? []) !== JSON.stringify(requiredConditions ?? [])
    )) {
      throw new Error(`federation insight id collision: ${id}`);
    }

    let inserted = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!existing) {
        if (this.groupRow(scope)?.status === "completed") {
          throw new Error(`federation scope is already completed: ${scope}`);
        }
        const result = this.db.prepare(
          `INSERT INTO federation_insights
           (id, scope, kind, source_session, source_project, source_fact, summary,
            confidence, required_conditions_json, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, scope, kind, source.sessionId, source.projectId, source.factId ?? null,
          summary, confidence, JSON.stringify(requiredConditions ?? []), publishedAt,
        );
        inserted = result.changes > 0;
      }

      if (inserted) {
        this.db.prepare(
          `INSERT INTO federation_deliveries (insight_id, target_session, status, updated_at)
           SELECT ?, m.session_id, 'pending', ?
           FROM federation_group_members m
           JOIN federation_groups g ON g.scope = m.scope AND g.generation = m.generation
           WHERE m.scope = ? AND m.status IN ('expected', 'active') AND m.session_id <> ?`,
        ).run(id, publishedAt, scope, source.sessionId);
      }

      // Publishing advances the group head for every member. Receivers with
      // pending work stay immediately before their first delivery; the source
      // session, which does not consume its own broadcast, advances to head.
      const sessions = this.db.prepare(
        `SELECT m.session_id FROM federation_group_members m
         JOIN federation_groups g ON g.scope = m.scope AND g.generation = m.generation
         WHERE m.scope = ? AND m.status IN ('expected', 'active')`,
      ).all(scope) as Array<{ session_id: string }>;
      for (const session of sessions) this.refreshCursor(session.session_id, scope);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const insight = this.getInsight(id);
    if (!insight) throw new Error(`failed to persist federation insight: ${id}`);
    if (inserted) this.emitter.emit("insight", insight);
    return insight;
  }

  subscribeInsights(listener: GlobalInsightListener): () => void {
    this.emitter.on("insight", listener);
    return () => { this.emitter.off("insight", listener); };
  }

  recentInsights(limit = 50, scope?: string): GlobalInsight[] {
    const rows = scope
      ? this.db.prepare("SELECT * FROM federation_insights WHERE scope = ? ORDER BY seq DESC LIMIT ?").all(scope, limit)
      : this.db.prepare("SELECT * FROM federation_insights ORDER BY seq DESC LIMIT ?").all(limit);
    return rows.reverse().map(insightFromRow);
  }

  insightsForSession(sessionId: string, limit = 50): GlobalInsight[] {
    const scope = this.sessionScope(sessionId);
    if (!scope) return [];
    return this.db.prepare(
      `SELECT * FROM federation_insights
       WHERE scope = ? AND source_session <> ? ORDER BY seq DESC LIMIT ?`,
    ).all(scope, sessionId, limit).reverse().map(insightFromRow);
  }

  pendingForSession(sessionId: string, limit = 50): GlobalInsight[] {
    const scope = this.sessionScope(sessionId);
    if (!scope) return [];
    return this.db.prepare(
      `SELECT i.* FROM federation_insights i
       JOIN federation_deliveries d ON d.insight_id = i.id
       WHERE d.target_session = ? AND i.scope = ? AND d.status IN ('pending', 'failed')
       ORDER BY i.seq LIMIT ?`,
    ).all(sessionId, scope, limit).map(insightFromRow);
  }

  acknowledge(
    sessionId: string,
    insightId: string,
    status: Exclude<DeliveryStatus, "pending">,
    evaluatedAgentId?: string,
  ): void {
    const scope = this.sessionScope(sessionId);
    if (!scope) throw new Error(`federation session not registered: ${sessionId}`);
    const result = this.db.prepare(
      `UPDATE federation_deliveries
       SET status = ?, evaluated_agent_id = ?, updated_at = ?
       WHERE target_session = ? AND insight_id = ?
         AND EXISTS (
           SELECT 1 FROM federation_insights i
           WHERE i.id = federation_deliveries.insight_id AND i.scope = ?
         )`,
    ).run(status, evaluatedAgentId ?? null, Date.now(), sessionId, insightId, scope);
    if (result.changes !== 1) throw new Error(`federation delivery not found: ${sessionId}/${insightId}`);
    this.refreshCursor(sessionId, scope);
  }

  markFailed(sessionId: string, insightId: string, evaluatedAgentId?: string): void {
    this.db.prepare(
      `UPDATE federation_deliveries SET status = 'failed', evaluated_agent_id = ?, updated_at = ?
       WHERE target_session = ? AND insight_id = ?`,
    ).run(evaluatedAgentId ?? null, Date.now(), sessionId, insightId);
  }

  headSeq(scope: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM federation_insights WHERE scope = ?").get(scope) as { seq: number };
    return Number(row.seq);
  }

  cursor(sessionId: string): number {
    const row = this.db.prepare("SELECT last_seq FROM federation_cursors WHERE session_id = ?").get(sessionId) as { last_seq: number } | undefined;
    return Number(row?.last_seq ?? 0);
  }

  hasPendingDeliveries(scope: string): boolean {
    return this.pendingDeliveryCount(scope) > 0;
  }

  private pendingDeliveryCount(scope: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM federation_deliveries d
       JOIN federation_insights i ON i.id = d.insight_id
       WHERE i.scope = ? AND d.status IN ('pending', 'failed')`,
    ).get(scope) as { count: number };
    return Number(row.count);
  }

  allCursorsAtHead(scope: string): boolean {
    const group = this.groupRow(scope);
    if (!group) return false;
    if (group.status === "completed") return true;
    const head = this.headSeq(scope);
    const rows = this.db.prepare(
      `SELECT m.status, c.last_seq FROM federation_group_members m
       LEFT JOIN federation_cursors c ON c.session_id = m.session_id AND c.scope = m.scope
       WHERE m.scope = ? AND m.generation = ?`,
    ).all(scope, group.generation) as Array<{ status: TaskGroupMemberStatus; last_seq: number | null }>;
    return rows.length > 0 && rows.every((row) => (
      row.status === "active" && Number(row.last_seq ?? -1) >= head
    ));
  }

  clear(): void {
    this.db.exec("DELETE FROM federation_deliveries; DELETE FROM federation_insights;");
    this.db.prepare("UPDATE federation_cursors SET last_seq = 0, updated_at = ?").run(Date.now());
  }

  private getInsight(id: string): GlobalInsight | undefined {
    const row = this.db.prepare("SELECT * FROM federation_insights WHERE id = ?").get(id);
    return row ? insightFromRow(row) : undefined;
  }

  private sessionScope(sessionId: string): string | undefined {
    const row = this.db.prepare("SELECT scope FROM federation_sessions WHERE session_id = ?").get(sessionId) as { scope: string } | undefined;
    return row?.scope;
  }

  private cursorForScope(sessionId: string, scope: string): number {
    const row = this.db.prepare(
      "SELECT last_seq FROM federation_cursors WHERE session_id = ? AND scope = ?",
    ).get(sessionId, scope) as { last_seq: number } | undefined;
    return Number(row?.last_seq ?? 0);
  }

  private refreshCursor(sessionId: string, scope: string): void {
    const pending = this.db.prepare(
      `SELECT MIN(i.seq) AS seq FROM federation_insights i
       JOIN federation_deliveries d ON d.insight_id = i.id
       WHERE d.target_session = ? AND i.scope = ? AND d.status IN ('pending', 'failed')`,
    ).get(sessionId, scope) as { seq: number | null };
    const lastSeq = pending.seq === null ? this.headSeq(scope) : Math.max(0, Number(pending.seq) - 1);
    this.db.prepare(
      "UPDATE federation_cursors SET last_seq = ?, updated_at = ? WHERE session_id = ?",
    ).run(lastSeq, Date.now(), sessionId);
  }

  private ensureCursor(sessionId: string, scope: string, now: number): void {
    this.db.prepare(
      `INSERT INTO federation_cursors (session_id, scope, last_seq, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seq = CASE WHEN federation_cursors.scope = excluded.scope THEN federation_cursors.last_seq ELSE 0 END,
         scope = excluded.scope,
         updated_at = excluded.updated_at`,
    ).run(sessionId, scope, now);
  }

  private groupRow(scope: string): { generation: number; status: TaskGroupStatus } | undefined {
    const row = this.db.prepare(
      "SELECT generation, status FROM federation_groups WHERE scope = ?",
    ).get(scope) as { generation: number; status: TaskGroupStatus } | undefined;
    return row && { generation: Number(row.generation), status: row.status };
  }

  private memberRow(
    scope: string,
    sessionId: string,
  ): { generation: number; status: TaskGroupMemberStatus } | undefined {
    const row = this.db.prepare(
      "SELECT generation, status FROM federation_group_members WHERE scope = ? AND session_id = ?",
    ).get(scope, sessionId) as { generation: number; status: TaskGroupMemberStatus } | undefined;
    return row && { generation: Number(row.generation), status: row.status };
  }

  private bumpGeneration(scope: string, now: number): number {
    const group = this.groupRow(scope);
    if (!group || group.status !== "running") throw new Error(`task group is not running: ${scope}`);
    const generation = group.generation + 1;
    this.db.prepare(
      "UPDATE federation_groups SET generation = ?, status = 'running', updated_at = ? WHERE scope = ?",
    ).run(generation, now, scope);
    this.db.prepare(
      "UPDATE federation_group_members SET generation = ?, updated_at = ? WHERE scope = ?",
    ).run(generation, now, scope);
    this.db.prepare(
      "UPDATE federation_sessions SET finish_ready = 0, completed = 0, updated_at = ? WHERE scope = ?",
    ).run(now, scope);
    return generation;
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

function insightFromRow(row: Record<string, unknown>): GlobalInsight {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    scope: String(row.scope),
    kind: String(row.kind) as InsightKind,
    source: {
      sessionId: String(row.source_session),
      projectId: String(row.source_project),
      factId: row.source_fact ? String(row.source_fact) : undefined,
    },
    summary: String(row.summary),
    confidence: Number(row.confidence),
    requiredConditions: JSON.parse(String(row.required_conditions_json ?? "[]")),
    publishedAt: Number(row.published_at),
  };
}
