/** Locate UUID-keyed persistent Session stores and the active Session pointer. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { sessionsDir } from "../config/peak-home.js";
import { SqliteGraph } from "../graph/sqlite-graph.js";
import type { Graph } from "../graph/graph.js";

export interface SessionInfo {
  sessionId: string;
  name?: string;
  dbPath: string;
  dir: string;
  exists: boolean;
}

export interface ActiveSession {
  name: string;
  id: string;
}

export class SessionManager {
  constructor(private readonly baseDir: string = sessionsDir()) {}

  create(name: string): ActiveSession {
    const normalized = requireName(name);
    const active = { name: normalized, id: randomUUID() };
    mkdirSync(join(this.sessionDir(active.id), "logs"), { recursive: true });
    this.activate(active);
    return active;
  }

  activate(session: ActiveSession): void {
    requireName(session.name);
    this.sessionDir(session.id);
    mkdirSync(this.baseDir, { recursive: true });
    writeFileSync(
      this.activePath(),
      `active:\n  name: ${yamlScalar(session.name)}\n  id: ${session.id}\n`,
      "utf8",
    );
  }

  active(): ActiveSession | undefined {
    if (!existsSync(this.activePath())) return undefined;
    const text = readFileSync(this.activePath(), "utf8");
    const name = /^\s*name:\s*(.+?)\s*$/m.exec(text)?.[1];
    const id = /^\s*id:\s*([0-9a-f-]+)\s*$/mi.exec(text)?.[1];
    if (!name || !id) throw new Error(`invalid active session file: ${this.activePath()}`);
    const parsed = { name: parseYamlScalar(name), id };
    this.sessionDir(parsed.id);
    return parsed;
  }

  resolve(nameOrId?: string): ActiveSession | undefined {
    if (!nameOrId) return this.active();
    if (isUuid(nameOrId)) {
      const info = this.info(nameOrId);
      if (!info.exists) return undefined;
      return { id: nameOrId, name: info.name ?? nameOrId };
    }
    for (const id of this.listSessions()) {
      const info = this.info(id);
      if (info.name === nameOrId) return { id, name: nameOrId };
    }
    return undefined;
  }

  sessionDir(sessionId: string): string {
    if (!isUuid(sessionId)) throw new Error(`session id must be a UUID: ${sessionId}`);
    const root = resolve(this.baseDir);
    const dir = resolve(root, sessionId);
    const rel = relative(root, dir);
    if (rel.startsWith("..") || resolve(root, rel) !== dir) {
      throw new Error(`refusing session id outside base directory: ${sessionId}`);
    }
    return dir;
  }

  dbPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "analysis.db");
  }

  info(sessionId: string): SessionInfo {
    const dir = this.sessionDir(sessionId);
    const dbPath = join(dir, "analysis.db");
    let name: string | undefined;
    if (existsSync(dbPath)) {
      const graph = new SqliteGraph(dbPath);
      try { name = graph.listProjects()[0]?.session; } finally { graph.close(); }
    }
    return { sessionId, name, dbPath, dir, exists: existsSync(dbPath) };
  }

  listSessions(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isUuid(entry.name))
      .map((entry) => entry.name)
      .filter((id) => existsSync(join(this.baseDir, id, "analysis.db")))
      .sort();
  }

  open(sessionId: string): Graph {
    const dir = this.sessionDir(sessionId);
    mkdirSync(join(dir, "logs"), { recursive: true });
    return new SqliteGraph(join(dir, "analysis.db"));
  }

  openReadOnly(sessionId: string): Graph {
    const info = this.info(sessionId);
    if (!info.exists) throw new Error(`session db not found: ${sessionId}`);
    return new SqliteGraph(info.dbPath);
  }

  delete(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (this.active()?.id === sessionId) rmSync(this.activePath(), { force: true });
  }

  private activePath(): string {
    return join(this.baseDir, ".session.yaml");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name || /\r|\n/.test(name)) throw new Error("session name must be a non-empty single line");
  return name;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function parseYamlScalar(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return requireName(parsed);
  } catch { /* plain YAML scalar */ }
  return requireName(value);
}
