import { closeSync, openSync, unlinkSync } from "node:fs";
import type { GraphClient } from "../graph/graph-client.js";
import { sourceTitle } from "./helpers.js";
import { persistProjectId } from "./task-config.js";
import type { ResolvedTaskConfig } from "./types.js";

/**
 * Creates every missing Project in one locked control-plane pass and persists
 * the complete UUID set before any sharded Dispatch process may start.
 */
export async function prepareTaskProjects(config: ResolvedTaskConfig, graph: GraphClient): Promise<string[]> {
  const lockPath = `${config.configPath}.prepare.lock`;
  let lock: number;
  try { lock = openSync(lockPath, "wx"); }
  catch { throw new Error(`Task Project preparation is already running: ${config.configPath}`); }
  try {
    const ids: string[] = [];
    for (let index = 0; index < config.board.projects.length; index += 1) {
      const configured = config.board.projects[index]!;
      let id: string;
      if (configured.id) {
        id = configured.id;
        const current = await graph.getProject(configured.id);
        const source = current.facts.find((fact) => fact.id === "origin")?.description;
        const goal = current.facts.find((fact) => fact.id === "goal")?.description;
        if (source !== configured.source || goal !== configured.goal) {
          throw new Error(`Task config does not match persisted Project: ${configured.id}`);
        }
      } else {
        const project = await graph.createProject({
          title: sourceTitle(configured.source), target: configured.source, goal: configured.goal,
        });
        persistProjectId(config, index, project.id);
        id = project.id;
      }
      ids.push(id);
    }
    return ids;
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch { /* best-effort cleanup after a failed preparation */ }
  }
}
