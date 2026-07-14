/**
 * Peak home directory layout.
 *
 * Centralizes all filesystem locations under a single root (default ~/.peak):
 *
 *   ~/.peak/
 *   ├── config.json          global baseline (default workers/control)
 *   ├── agents/<name>.json   reusable role configs injected into builtin slots
 *   ├── tasks/<name>.json    task configs (target/goal/session + agent refs)
 *   ├── sessions/<session>/  per-session execution state (analysis.db)
 *   └── providers.json       model provider configs
 *
 * Override the root with the PEAK_HOME env var. This is the single source of
 * truth for the layout — SessionManager, loadConfig, and the CLI all route
 * through these helpers.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

/** Resolve the peak home root: PEAK_HOME env, else ~/.peak. */
export function peakHome(): string {
  const fromEnv = process.env.PEAK_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return join(homedir(), ".peak");
}

/** Join segments under the peak home root. */
export function peakPath(...segments: string[]): string {
  return join(peakHome(), ...segments);
}

/** ~/.peak/agents — reusable role configs. */
export function agentsDir(): string {
  return peakPath("agents");
}

/** ~/.peak/tasks — task configs. */
export function tasksDir(): string {
  return peakPath("tasks");
}

/** ~/.peak/sessions — per-session execution state. */
export function sessionsDir(): string {
  return peakPath("sessions");
}

/** ~/.peak/providers.json — model provider configs. */
export function providersFile(): string {
  return peakPath("providers.json");
}

/** ~/.peak/config.json — global baseline config. */
export function configFile(): string {
  return peakPath("config.json");
}

/**
 * Idempotently ensure the peak home subdirectories exist. Safe to call on every
 * run; creates {agents,tasks,sessions} if missing, never throws on existing.
 */
export function ensurePeakLayout(): void {
  const root = peakHome();
  for (const sub of ["agents", "tasks", "sessions"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Path to a named agent config: ~/.peak/agents/<name>.json. */
export function agentFile(name: string): string {
  return join(agentsDir(), `${name}.json`);
}

/** Path to a named task config: ~/.peak/tasks/<name>.json. */
export function taskFile(name: string): string {
  return join(tasksDir(), `${name}.json`);
}
