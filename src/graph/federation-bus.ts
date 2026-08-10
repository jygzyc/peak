import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeProjectLog } from "../utils/helpers.js";
import { pathAbstractPath, pathAbstractRelativePath, readPathAbstract } from "./path-abstract.js";
import type { FactRef, ResolvedPathAbstract } from "./types.js";

/** Durable broadcast unit. Plan sees only `leaf` plus the resolved read-only `pathAbs`. */
export interface PathReference { projectId: string; leaf: FactRef; pathAbs: string; segments: FactRef[][] }
interface Registration { scope?: string; projectDir: string }

export class FederationBus {
  private readonly projects = new Map<string, Registration>();
  private readonly pending = new Map<string, PathReference[]>();
  private readonly delivered = new Map<string, Set<string>>();

  /** Attaches one Project shard and replays its main.log to rebuild pending deliveries. */
  register(projectId: string, projectDir: string, scope?: string): void {
    this.projects.set(projectId, { projectDir, scope });
    this.rebuild();
  }

  /**
   * Broadcasts one leaf Path to every other same-scope registered Project:
   * appends the durable send event to the source main.log, retires superseded
   * interior-leaf Paths, then queues the delivery in memory. Publishing is
   * idempotent per (target, path) pair.
   */
  publishPath(ref: PathReference): void {
    const source = this.projects.get(ref.projectId);
    if (!source) throw new Error(`federation source not registered: ${ref.projectId}`);
    // A leaf consumed by a newer concluded Intent appears as an interior node
    // of the new Path; its older Path is stale and retires automatically.
    const interior = new Set(
      ref.segments.flat().filter((step) => step.projectId === ref.projectId && step.id !== ref.leaf.id)
        .map((step) => `${step.projectId}/${step.id}`),
    );
    for (const [targetProjectId, target] of this.projects) {
      if (targetProjectId === ref.projectId || target.scope !== source.scope) continue;
      if (this.has(targetProjectId, ref)) continue;
      writeProjectLog(source.projectDir, "send_path_reference", { targetProjectId, ...ref, retires: [...interior] });
      this.retire(targetProjectId, interior);
      this.markDelivered(targetProjectId, ref);
      this.queue(targetProjectId, ref);
    }
  }

  /** Paths delivered to this Project and not yet consumed by a Plan round. */
  pendingPathsFor(projectId: string): PathReference[] {
    return [...(this.pending.get(projectId) ?? [])];
  }

  resolvePath(ref: PathReference): ResolvedPathAbstract {
    const source = this.projects.get(ref.leaf.projectId);
    if (!source || ref.projectId !== ref.leaf.projectId) throw new Error(`federation source not registered: ${ref.leaf.projectId}`);
    if (ref.pathAbs !== pathAbstractRelativePath(ref.leaf.id)) throw new Error(`invalid PathAbstract path: ${ref.pathAbs}`);
    const inputPath = pathAbstractPath(source.projectDir, ref.leaf.id);
    if (!existsSync(inputPath)) throw new Error(`PathAbstract not found: ${ref.leaf.projectId}/${ref.leaf.id}`);
    const stat = lstatSync(inputPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`PathAbstract not found: ${ref.leaf.projectId}/${ref.leaf.id}`);
    const abstract = readPathAbstract(source.projectDir, ref.leaf.id);
    if (!abstract || abstract.factRef.projectId !== ref.leaf.projectId
      || abstract.factRef.id !== ref.leaf.id || abstract.factRef.description !== ref.leaf.description) {
      throw new Error(`PathAbstract FactRef mismatch: ${ref.leaf.projectId}/${ref.leaf.id}`);
    }
    return { factRef: ref.leaf, pathAbs: { inputPath, readOnly: true } };
  }

  /** Marks delivered Paths as consumed by a Plan round and appends the durable receive events. */
  markPathsHandled(projectId: string, refs: PathReference[]): void {
    const registration = this.projects.get(projectId);
    if (!registration) throw new Error(`federation target not registered: ${projectId}`);
    const keys = new Set(refs.map(key));
    for (const ref of refs) writeProjectLog(registration.projectDir, "receive_path_reference", { ...ref });
    this.pending.set(projectId, (this.pending.get(projectId) ?? []).filter((ref) => !keys.has(key(ref))));
  }

  private rebuild(): void {
    this.pending.clear();
    this.delivered.clear();
    const sends: Array<{ targetProjectId: string; ref: PathReference; retires: Set<string> }> = [];
    const handled = new Map<string, Set<string>>();
    for (const [projectId, registration] of this.projects) {
      for (const event of this.events(registration.projectDir)) {
        if (event.type === "send_path_reference" && typeof event.targetProjectId === "string") {
          const ref = parseReference(event);
          if (ref) sends.push({ targetProjectId: event.targetProjectId, ref, retires: new Set(parseKeys(event.retires)) });
        }
        if (event.type === "receive_path_reference") {
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
      this.retire(send.targetProjectId, send.retires);
      this.markDelivered(send.targetProjectId, send.ref);
      if (!handled.get(send.targetProjectId)?.has(key(send.ref))) this.queue(send.targetProjectId, send.ref);
    }
  }

  private queue(projectId: string, ref: PathReference): void {
    this.pending.set(projectId, [...(this.pending.get(projectId) ?? []), ref]);
  }
  private retire(projectId: string, keys: Set<string>): void {
    if (keys.size === 0) return;
    this.pending.set(projectId, (this.pending.get(projectId) ?? []).filter((ref) => !keys.has(key(ref))));
  }
  private has(projectId: string, ref: PathReference): boolean {
    return this.delivered.get(projectId)?.has(key(ref)) ?? false;
  }
  private markDelivered(projectId: string, ref: PathReference): void {
    const values = this.delivered.get(projectId) ?? new Set<string>();
    values.add(key(ref));
    this.delivered.set(projectId, values);
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

function key(ref: PathReference): string { return `${ref.projectId}/${ref.leaf.id}`; }
function parseReference(value: Record<string, unknown>): PathReference | undefined {
  const leaf = parseFactRef(value.leaf);
  if (typeof value.projectId !== "string" || !leaf || typeof value.pathAbs !== "string") return undefined;
  const segments = Array.isArray(value.segments)
    ? value.segments.flatMap((segment) => {
      if (!Array.isArray(segment)) return [];
      const steps = segment.flatMap((item) => {
        const ref = parseFactRef(item);
        return ref ? [ref] : [];
      });
      return steps.length > 0 ? [steps] : [];
    })
    : [];
  return { projectId: value.projectId, leaf, pathAbs: value.pathAbs, segments };
}
function parseFactRef(value: unknown): FactRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  return typeof ref.projectId === "string" && typeof ref.id === "string" && typeof ref.description === "string"
    ? { projectId: ref.projectId, id: ref.id, description: ref.description }
    : undefined;
}
function parseKeys(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
