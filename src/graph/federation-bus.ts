/** Process-local coordination for Fact references shared between Sessions.
 *
 * Broadcasts are not Graph rows. Metacog records sends/receives in each
 * Session's logs/main.log; this coordinator rebuilds its queue from those logs
 * when Sessions are registered again.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fact } from "../agent/types.js";
import type { Graph } from "./graph.js";

export type TaskGroupStatus = "running" | "completed";
export type TaskGroupMemberStatus = "active" | "completed";

export interface FactBroadcast {
  sessionId: string;
  factId: string;
  reason: string;
}

export interface TaskGroupState {
  scope: string;
  status: TaskGroupStatus;
  pendingBroadcasts: number;
  members: Array<{
    sessionId: string;
    projectId?: string;
    status: TaskGroupMemberStatus;
    finishReady: boolean;
    completed: boolean;
  }>;
}

interface RegisteredSession {
  scope: string;
  projectId?: string;
  graph: Graph;
  finishReady: boolean;
  completed: boolean;
  handled: Set<string>;
}

export class FederationBus {
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly broadcasts = new Map<string, FactBroadcast>();
  private readonly completedScopes = new Set<string>();

  close(): void {
    this.sessions.clear();
    this.broadcasts.clear();
    this.completedScopes.clear();
  }

  registerSession(sessionId: string, scope: string, projectId: string | undefined, graph: Graph): void {
    if (!sessionId || !scope) throw new Error("federation session and scope must be non-empty");
    const handled = new Set<string>();
    this.sessions.set(sessionId, {
      scope,
      projectId,
      graph,
      finishReady: false,
      completed: false,
      handled,
    });
    this.loadLog(sessionId, graph, handled);
  }

  publish(broadcast: FactBroadcast): FactBroadcast {
    const source = this.requireSession(broadcast.sessionId);
    const fact = source.projectId
      ? source.graph.getFact(source.projectId, broadcast.factId)
      : undefined;
    if (!fact || fact.status !== "pass") {
      throw new Error(`broadcast source is not a pass Fact: ${broadcast.sessionId}/${broadcast.factId}`);
    }
    const key = broadcastKey(broadcast);
    const existing = this.broadcasts.get(key);
    if (existing && existing.reason !== broadcast.reason) {
      throw new Error(`Fact broadcast already exists with a different reason: ${key}`);
    }
    this.broadcasts.set(key, existing ?? broadcast);
    return existing ?? broadcast;
  }

  sourceFact(broadcast: FactBroadcast): Fact | undefined {
    const source = this.sessions.get(broadcast.sessionId);
    return source?.projectId
      ? source.graph.getFact(source.projectId, broadcast.factId)
      : undefined;
  }

  recentBroadcasts(limit = 50, scope?: string): FactBroadcast[] {
    return [...this.broadcasts.values()]
      .filter((broadcast) => !scope || this.sessions.get(broadcast.sessionId)?.scope === scope)
      .slice(-limit)
      .reverse();
  }

  pendingForSession(sessionId: string, limit = 50): FactBroadcast[] {
    const target = this.requireSession(sessionId);
    return [...this.broadcasts.values()]
      .filter((broadcast) => broadcast.sessionId !== sessionId)
      .filter((broadcast) => this.sessions.get(broadcast.sessionId)?.scope === target.scope)
      .filter((broadcast) => !target.handled.has(broadcastKey(broadcast)))
      .slice(0, limit);
  }

  markHandled(sessionId: string, broadcast: FactBroadcast): void {
    this.requireSession(sessionId).handled.add(broadcastKey(broadcast));
  }

  hasPendingBroadcasts(scope: string): boolean {
    return this.registeredSessions(scope).some((member) => this.pendingForSession(member.sessionId, 1).length > 0);
  }

  setSessionFinishReady(sessionId: string, projectId: string, ready: boolean): void {
    const session = this.requireSession(sessionId);
    session.projectId = projectId;
    session.finishReady = ready;
  }

  allSessionsFinishReady(scope: string): boolean {
    const members = this.registeredSessions(scope);
    return members.length > 0 && members.every((member) => member.finishReady || member.completed);
  }

  tryCompleteScope(scope: string): boolean {
    if (!this.allSessionsFinishReady(scope) || this.hasPendingBroadcasts(scope)) return false;
    this.completedScopes.add(scope);
    for (const session of this.sessions.values()) {
      if (session.scope === scope) session.completed = true;
    }
    return true;
  }

  registeredSessions(scope: string): Array<{
    sessionId: string;
    projectId?: string;
    scope: string;
    finishReady: boolean;
    completed: boolean;
  }> {
    return [...this.sessions.entries()]
      .filter(([, session]) => session.scope === scope)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sessionId, session]) => ({
        sessionId,
        projectId: session.projectId,
        scope,
        finishReady: session.finishReady,
        completed: session.completed,
      }));
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  taskGroup(scope: string): TaskGroupState | undefined {
    const members = this.registeredSessions(scope);
    if (members.length === 0) return undefined;
    return {
      scope,
      status: this.completedScopes.has(scope) ? "completed" : "running",
      pendingBroadcasts: members.reduce(
        (count, member) => count + this.pendingForSession(member.sessionId, Number.MAX_SAFE_INTEGER).length,
        0,
      ),
      members: members.map((member) => ({
        ...member,
        status: member.completed ? "completed" : "active",
      })),
    };
  }

  taskGroups(): TaskGroupState[] {
    const scopes = new Set([...this.sessions.values()].map((session) => session.scope));
    return [...scopes].sort().map((scope) => this.taskGroup(scope)!).filter(Boolean);
  }

  private requireSession(sessionId: string): RegisteredSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`federation session is not registered: ${sessionId}`);
    return session;
  }

  private loadLog(sessionId: string, graph: Graph, handled: Set<string>): void {
    const project = graph.listProjects()[0];
    if (!project) return;
    const path = join(project.sessionDir, "logs", "main.log");
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const changes = entry.changes as Record<string, unknown> | undefined;
        if (!changes) continue;
        if (entry.operation === "send_fact_broadcast"
          && typeof entry.sessionId === "string"
          && typeof changes.factId === "string"
          && typeof changes.reason === "string") {
          const broadcast = {
            sessionId: entry.sessionId,
            factId: changes.factId,
            reason: changes.reason,
          };
          this.broadcasts.set(broadcastKey(broadcast), broadcast);
        }
        if (entry.operation === "receive_fact_broadcast"
          && typeof changes.sourceSessionId === "string"
          && typeof changes.factId === "string") {
          handled.add(`${changes.sourceSessionId}:${changes.factId}`);
        }
      } catch { /* malformed audit lines do not become broadcasts */ }
    }
    if (project.sessionId !== sessionId) {
      throw new Error(`registered Session does not match Graph: ${sessionId}`);
    }
  }
}

export function broadcastKey(broadcast: Pick<FactBroadcast, "sessionId" | "factId">): string {
  return `${broadcast.sessionId}:${broadcast.factId}`;
}
