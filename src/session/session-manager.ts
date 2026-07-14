/**
 * Session registry for peak graph stores.
 *
 * Maps task sessions to filesystem locations, creates/open SQLite graph files,
 * and lists/deletes saved sessions. Runtime state remains per-session; this
 * manager only locates and lifecycle-manages those stores.
 */

import { mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { SqliteGraph } from "../graph/sqlite-graph.js";
import type { Graph } from "../graph/graph.js";
import { safeSessionName } from "../config/utils.js";
import { sessionsDir } from "../config/peak-home.js";

export interface SessionInfo {
  sessionId: string;
  dbPath: string;
  dir: string;
  exists: boolean;
}

export class SessionManager {
  constructor(private readonly baseDir: string = sessionsDir()) {}

  sessionDir(sessionId: string): string {
    // Sanitize on the single entry point that every other method routes
    // through, and verify the resolved path stays inside baseDir. Without this,
    // a sessionId like "../evil" would escape baseDir via join() — letting
    // open() create and delete() rmSync directories outside the session root
    // (docs 04-session.md §4.5).
    const safe = safeSessionName(sessionId);
    const dir = resolve(this.baseDir, safe);
    const rel = relative(this.baseDir, dir);
    if (rel.startsWith("..") || resolve(this.baseDir, rel) !== dir) {
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
    return { sessionId, dbPath, dir, exists: existsSync(dbPath) };
  }

  listSessions(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(join(this.baseDir, name, "analysis.db")))
      .sort();
  }

  open(sessionId: string): Graph {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    return new SqliteGraph(join(dir, "analysis.db"));
  }

  openReadOnly(sessionId: string): Graph {
    const info = this.info(sessionId);
    if (!info.exists) throw new Error(`session db not found: ${sessionId}`);
    const ro = new SqliteGraph(info.dbPath);
    return ro;
  }

  delete(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
