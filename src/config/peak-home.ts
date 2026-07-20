/**
 * Peak home directory layout.
 *
 * Centralizes all filesystem locations under a single root (default ~/.peak):
 *
 *   ~/.peak/
 *   ├── sessions/.session.yaml
 *   ├── sessions/<uuid>/analysis.db
 *   ├── sessions/<uuid>/logs/
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

/** ~/.peak/sessions — per-session execution state. */
export function sessionsDir(): string {
  return peakPath("sessions");
}

/**
 * Idempotently ensure the peak home subdirectories exist. Safe to call on every
 * run; creates sessions if missing, never throws on existing.
 */
export function ensurePeakLayout(): void {
  const root = peakHome();
  for (const sub of ["sessions"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
