/** Read and append Server-applied role operations in the Session's main.log. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../agent/types.js";

export function appendGraphOperation(
  project: Project,
  role: string,
  operation: string,
  changes: Record<string, unknown>,
): void {
  const logsDir = join(project.sessionDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  appendFileSync(join(logsDir, "main.log"), `${JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionId: project.sessionId,
    projectId: project.id,
    role,
    operation,
    changes,
  })}\n`, "utf8");
}

export interface GraphOperation {
  timestamp: string;
  sessionId: string;
  projectId: string;
  role: string;
  operation: string;
  changes: Record<string, unknown>;
}

export function graphOperations(project: Project, operation?: string): GraphOperation[] {
  const path = join(project.sessionDir, "logs", "main.log");
  if (!existsSync(path)) return [];
  const entries: GraphOperation[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as GraphOperation;
      if (entry.projectId === project.id && (!operation || entry.operation === operation)) {
        entries.push(entry);
      }
    } catch { /* malformed audit lines are ignored */ }
  }
  return entries;
}
