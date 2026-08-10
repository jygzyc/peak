import { claudeCodeProtocol } from "./backends/claude-code.js";
import { codexProtocol } from "./backends/codex.js";
import { opencodeProtocol } from "./backends/opencode.js";
import { piProtocol } from "./backends/pi.js";
import type { WorkerProtocol, WorkerType } from "./types.js";

/** Skill discovery directory a Worker backend reads (see `config/paths.ts`). */
type WorkerSkillDirectory = "agents" | "claude";

interface WorkerRegistration {
  protocol: WorkerProtocol;
  /** Global Skill discovery directories this backend reads; empty means none. */
  skillDirectories: readonly WorkerSkillDirectory[];
}

/**
 * The single Worker backend registry: adding a backend means implementing its
 * stateless `WorkerProtocol` and adding exactly one entry here. Worker type
 * validation, Skill discovery, protocol dispatch, and CLI listing derive
 * from this table; phase routing remains in config/Runtime.
 */
export const WORKER_REGISTRY: Readonly<Record<WorkerType, WorkerRegistration>> = {
  opencode: { protocol: opencodeProtocol, skillDirectories: ["agents"] },
  codex: { protocol: codexProtocol, skillDirectories: [] },
  pi: { protocol: piProtocol, skillDirectories: ["agents"] },
  "claude-code": { protocol: claudeCodeProtocol, skillDirectories: ["claude"] },
};

export const WORKER_TYPES = Object.keys(WORKER_REGISTRY) as WorkerType[];

export const WORKER_PROTOCOLS: Record<WorkerType, WorkerProtocol> = Object.fromEntries(
  Object.entries(WORKER_REGISTRY).map(([type, registration]) => [type, registration.protocol]),
) as Record<WorkerType, WorkerProtocol>;
