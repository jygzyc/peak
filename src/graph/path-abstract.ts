import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeArtifactDirectory } from "../utils/paths.js";
import { requireDescription, requireShortDescription } from "./api.js";
import type { FactRef, PathAbstract } from "./types.js";

export const PATH_ABSTRACT_PREFIX = "path_abs_";

export function pathAbstractRelativePath(factId: string): string {
  requirePathFactId(factId);
  return `artifacts/${PATH_ABSTRACT_PREFIX}${factId}`;
}

export function pathAbstractPath(projectDir: string, factId: string): string {
  requirePathFactId(factId);
  return join(initializeArtifactDirectory(projectDir), `${PATH_ABSTRACT_PREFIX}${factId}`);
}

export function readPathAbstract(projectDir: string, factId: string): PathAbstract | null {
  const path = pathAbstractPath(projectDir, factId);
  if (!existsSync(path)) return null;
  try { return parsePathAbstract(JSON.parse(readFileSync(path, "utf8")) as unknown); }
  catch { return null; }
}

/** Path abstracts are immutable Fact artifacts; the first valid write wins. */
export function writePathAbstract(projectDir: string, factId: string, value: unknown): PathAbstract {
  const abstract = parsePathAbstract(value);
  if (abstract.factRef.id !== factId) throw new Error("PathAbstract Fact id mismatch");
  const target = pathAbstractPath(projectDir, factId);
  const existing = readPathAbstract(projectDir, factId);
  if (existing) return existing;
  const temporary = join(initializeArtifactDirectory(projectDir), `.${PATH_ABSTRACT_PREFIX}${factId}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(abstract, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
    chmodSync(target, 0o444);
    return abstract;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function parsePathAbstract(value: unknown): PathAbstract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PathAbstract must be an object");
  const record = value as Record<string, unknown>;
  exact(record, ["factRef", "pathOverview", "verifiedCore"]);
  const ref = factRef(record.factRef);
  if (!Array.isArray(record.verifiedCore) || record.verifiedCore.length === 0 || record.verifiedCore.length > 16) {
    throw new Error("verifiedCore must contain 1-16 items");
  }
  return {
    factRef: ref,
    pathOverview: requireDescription(record.pathOverview, "pathOverview"),
    verifiedCore: record.verifiedCore.map((item) => requireShortDescription(item, "verifiedCore")),
  };
}

function factRef(value: unknown): FactRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("factRef must be an object");
  const ref = value as Record<string, unknown>;
  exact(ref, ["projectId", "id", "description"]);
  return {
    projectId: requireDescription(ref.projectId, "factRef.projectId"),
    id: requireShortDescription(ref.id, "factRef.id"),
    description: requireDescription(ref.description, "factRef.description"),
  };
}

function requirePathFactId(factId: string): void {
  if (!/^f\d{4,}$/.test(factId)) throw new Error(`invalid PathAbstract Fact id: ${factId}`);
}

function exact(value: Record<string, unknown>, fields: string[]): void {
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  const missing = fields.find((key) => !(key in value));
  if (unknown || missing) throw new Error(unknown ? `unknown field: ${unknown}` : `missing field: ${missing}`);
}
