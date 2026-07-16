/**
 * GlobalSupervisor — process-level controller for multiple sessions.
 *
 * Per the subagent control-plane plan, multi-task scheduling should NOT use a
 * single global MainAgent. Instead, one GlobalSupervisor manages N
 * session-local SessionLoops, each with its own MainAgent/Planner and Metacog.
 *
 * Responsibilities:
 *   - Register/unregister SessionLoops by session id
 *   - Provide a global tick that steps all active loops concurrently
 *   - Bound the number of session ticks executing concurrently
 *   - Own the cross-session FederationBus
 *
 * The supervisor does NOT own per-session planning, graph mutation, or metacog
 * scheduling — those remain session-local for context isolation, independent
 * resume/pause/stop, and clear permission boundaries.
 */

import type { ProjectId } from "../agent/types.js";
import type { SessionLoop, StepResult } from "./session-loop.js";
import { FederationBus } from "../graph/federation-bus.js";
import { GlobalResourceGovernor } from "../worker/resource-governor.js";
import { federationFile } from "../config/peak-home.js";

export interface RegisteredSession {
  id: string;
  loop: SessionLoop;
  projectId?: ProjectId;
  scope: string;
}

export interface RegisterSessionOptions {
  projectId?: ProjectId;
  scope?: string;
}

export interface GlobalTickResult {
  sessionId: string;
  result: StepResult;
}

export interface GlobalSupervisorOptions {
  globalMaxConcurrent?: number;
  federationBus?: FederationBus;
}

export class GlobalSupervisor {
  private sessions = new Map<string, RegisteredSession>();
  readonly federationBus: FederationBus;
  readonly globalMaxConcurrent: number;
  readonly resourceGovernor: GlobalResourceGovernor;

  constructor(options: GlobalSupervisorOptions = {}) {
    this.federationBus = options.federationBus ?? new FederationBus({ dbPath: federationFile() });
    this.globalMaxConcurrent = options.globalMaxConcurrent ?? Infinity;
    this.resourceGovernor = new GlobalResourceGovernor(this.globalMaxConcurrent);
  }

  register(id: string, loop: SessionLoop, options: RegisterSessionOptions = {}): void {
    if (this.sessions.has(id)) {
      throw new Error(`session already registered: ${id}`);
    }
    const inferredProjects = loop.projectIds();
    if (inferredProjects.length > 1) {
      throw new Error(`session "${id}" exposes multiple projects; one session must equal one task`);
    }
    const projectId = options.projectId ?? (inferredProjects.length === 1 ? inferredProjects[0] : undefined);
    const scope = options.scope ?? loop.taskGroupScope();
    loop.setFederation(this.federationBus, id, scope);
    try {
      loop.setResourceGovernor(this.resourceGovernor);
    } catch (error) {
      loop.unsetFederation(this.federationBus, id);
      throw error;
    }
    this.sessions.set(id, { id, loop, projectId, scope });
  }

  unregister(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.loop.unsetFederation(this.federationBus, id);
    this.sessions.delete(id);
  }

  get(id: string): SessionLoop | undefined {
    return this.sessions.get(id)?.loop;
  }

  listSessions(): RegisteredSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Step every active session concurrently. Each SessionLoop coalesces a
   * project's in-flight step; the supervisor bounds session tick admission and
   * its resource governor separately bounds actual worker executions.
   */
  async tick(): Promise<GlobalTickResult[]> {
    const active = [...this.sessions.values()];
    const limit = Number.isFinite(this.globalMaxConcurrent)
      ? this.globalMaxConcurrent
      : Math.max(1, active.length);
    const output: GlobalTickResult[] = [];

    for (let offset = 0; offset < active.length; offset += limit) {
      const batch = active.slice(offset, offset + limit);
      const results = await Promise.allSettled(
        batch.map(async ({ id, loop }) => {
          const stepResults = await loop.tick();
          return { sessionId: id, result: stepResults[0] ?? { type: "idle" as const, reason: "no active projects" } };
        }),
      );
      output.push(...results.map((r, idx) => {
        const sessionId = batch[idx]!.id;
        if (r.status === "fulfilled") return r.value;
        return {
          sessionId,
          result: { type: "failed" as const, reason: `exception: ${(r.reason as Error)?.message ?? String(r.reason)}` },
        };
      }));
    }
    this.refreshPersistentFinishReadiness();
    this.completeQuiescentGroups();
    for (const item of output) {
      const registered = this.sessions.get(item.sessionId);
      if (registered?.projectId && item.result.type === "idle"
        && registered.loop.projectStatus(registered.projectId) === "completed") {
        item.result = { type: "completed" };
      }
    }
    return output;
  }

  async stepSession(sessionId: string, projectId: ProjectId): Promise<StepResult | undefined> {
    const loop = this.sessions.get(sessionId)?.loop;
    if (!loop) return undefined;
    return loop.step(projectId);
  }

  private completeQuiescentGroups(): void {
    const groups = new Map<string, RegisteredSession[]>();
    for (const session of this.sessions.values()) {
      const members = groups.get(session.scope) ?? [];
      members.push(session);
      groups.set(session.scope, members);
    }

    for (const [scope, members] of groups) {
      if (members.length === 0 || members.some((member) => !member.projectId)) continue;
      if (members.some((member) => !this.memberFinishReady(member))) continue;
      const generation = this.federationBus.groupGeneration(scope);
      if (generation === undefined) continue;
      // The persistent bus serializes this decision with publishInsight(), so a
      // broadcast cannot slip between a queue/head check and group completion.
      if (!this.federationBus.tryCompleteScope(scope, generation)) continue;

      // Session DBs remain intentionally isolated. Each member has already
      // persisted its EndFact and final review; the durable scope decision above
      // is the monotonic commit point and these local transitions materialize it.
      for (const member of members) {
        if (member.loop.projectStatus(member.projectId!) !== "completed") {
          member.loop.completeFromSupervisor(member.projectId!);
        }
      }
    }
  }

  private refreshPersistentFinishReadiness(): void {
    for (const member of this.sessions.values()) {
      if (!member.projectId) continue;
      this.federationBus.setSessionFinishReady(
        member.id,
        member.projectId,
        this.memberFinishReady(member),
      );
    }
  }

  private memberFinishReady(member: RegisteredSession): boolean {
    if (!member.projectId) return false;
    return member.loop.projectStatus(member.projectId) === "completed"
      || member.loop.canCompleteFromSupervisor(member.projectId);
  }
}
