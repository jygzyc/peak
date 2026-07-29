import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeProjectLogsDirectory } from "../config/paths.js";
import type { FactRef } from "./types.js";

export type FederationReference = FactRef;
interface Registration { scope?: string; projectDir: string }

export class FederationBus {
  private readonly projects = new Map<string, Registration>();
  private readonly pending = new Map<string, FederationReference[]>();
  private readonly delivered = new Map<string, Set<string>>();

  register(projectId: string, projectDir: string, scope?: string): void {
    this.projects.set(projectId, { projectDir, scope });
    this.rebuild();
  }

  unregister(projectId: string): void {
    this.projects.delete(projectId);
    this.pending.delete(projectId);
    this.delivered.delete(projectId);
  }

  publish(ref: FactRef, supersedes: FactRef[] = []): void {
    const source = this.projects.get(ref.projectId);
    if (!source) throw new Error(`federation source not registered: ${ref.projectId}`);
    const replaced = supersedes.filter((item) => item.projectId === ref.projectId);
    for (const [targetProjectId, target] of this.projects) {
      if (targetProjectId === ref.projectId || target.scope !== source.scope) continue;
      if (this.has(targetProjectId, ref)) continue;
      this.log(source.projectDir, { type: "send_fact_reference", targetProjectId, ...ref, supersedes: replaced });
      this.retire(targetProjectId, replaced);
      this.markDelivered(targetProjectId, ref);
      this.queue(targetProjectId, ref);
    }
  }

  pendingFor(projectId: string): FederationReference[] {
    return [...(this.pending.get(projectId) ?? [])];
  }

  markHandled(projectId: string, refs: FederationReference[]): void {
    const registration = this.projects.get(projectId);
    if (!registration) throw new Error(`federation target not registered: ${projectId}`);
    const keys = new Set(refs.map(key));
    for (const ref of refs) this.log(registration.projectDir, { type: "receive_fact_reference", ...ref });
    this.pending.set(projectId, (this.pending.get(projectId) ?? []).filter((ref) => !keys.has(key(ref))));
  }

  private rebuild(): void {
    this.pending.clear();
    this.delivered.clear();
    const sends: Array<{ targetProjectId: string; ref: FederationReference; supersedes: FactRef[] }> = [];
    const handled = new Map<string, Set<string>>();
    for (const [projectId, registration] of this.projects) {
      for (const event of this.events(registration.projectDir)) {
        if (event.type === "send_fact_reference" && typeof event.targetProjectId === "string") {
          const ref = parseReference(event);
          if (ref) sends.push({ targetProjectId: event.targetProjectId, ref, supersedes: parseFactRefs(event.supersedes) });
        }
        if (event.type === "receive_fact_reference") {
          const ref = parseReference(event);
          if (ref) {
            const values = handled.get(projectId) ?? new Set<string>();
            values.add(key(ref));
            handled.set(projectId, values);
          }
        }
      }
    }
    for (const send of sends) {
      if (!this.projects.has(send.targetProjectId)) continue;
      this.retire(send.targetProjectId, send.supersedes);
      this.markDelivered(send.targetProjectId, send.ref);
      if (!handled.get(send.targetProjectId)?.has(key(send.ref))) this.queue(send.targetProjectId, send.ref);
    }
  }

  private queue(projectId: string, ref: FederationReference): void {
    this.pending.set(projectId, [...(this.pending.get(projectId) ?? []), ref]);
  }
  private retire(projectId: string, refs: FactRef[]): void {
    const retired = new Set(refs.map(key));
    if (retired.size === 0) return;
    this.pending.set(projectId, (this.pending.get(projectId) ?? []).filter((ref) => !retired.has(key(ref))));
  }
  private has(projectId: string, ref: FederationReference): boolean {
    return this.delivered.get(projectId)?.has(key(ref)) ?? false;
  }
  private markDelivered(projectId: string, ref: FederationReference): void {
    const values = this.delivered.get(projectId) ?? new Set<string>();
    values.add(key(ref));
    this.delivered.set(projectId, values);
  }
  private log(projectDir: string, event: Record<string, unknown>): void {
    const dir = initializeProjectLogsDirectory(projectDir);
    appendFileSync(join(dir, "main.log"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  }
  private events(projectDir: string): Array<Record<string, unknown>> {
    const path = join(projectDir, "logs", "main.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
      } catch { return []; }
    });
  }
}

function key(ref: FactRef): string { return `${ref.projectId}/${ref.factId}`; }
function parseReference(value: Record<string, unknown>): FederationReference | undefined {
  if (typeof value.projectId !== "string" || typeof value.factId !== "string" || typeof value.description !== "string") return undefined;
  return { projectId: value.projectId, factId: value.factId, description: value.description };
}
function parseFactRefs(value: unknown): FactRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const ref = item as Record<string, unknown>;
    return typeof ref.projectId === "string" && typeof ref.factId === "string" && typeof ref.description === "string"
      ? [{ projectId: ref.projectId, factId: ref.factId, description: ref.description }]
      : [];
  });
}
