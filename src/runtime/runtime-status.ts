import { randomUUID } from "node:crypto";

/**
 * Runtime heartbeat snapshot. Pure in-memory, never persisted: a UI client
 * compares `heartbeatAt` against its own clock and the configured window to
 * decide whether the Runtime is online. `schedulerRunning` flips false once
 * the scheduler is stopped, even before the process exits.
 */
export interface RuntimeStatusSnapshot {
  runtimeId: string;
  startedAt: string;
  heartbeatAt: number;
  sequence: number;
  schedulerRunning: boolean;
}

/**
 * Heartbeat staleness window: a Runtime whose heartbeat has not advanced within
 * this many milliseconds is treated as offline by API/UI clients. Kept well
 * above the scheduler interval so a single missed tick does not flap.
 */
export const RUNTIME_HEARTBEAT_WINDOW_MS = 15_000;

/**
 * Pure in-memory Runtime liveness. A fixed `setInterval` advances
 * `heartbeatAt` (epoch ms) and `sequence` on every tick. There is intentionally
 * no per-Worker heartbeat or lease: Peak is the parent of every Agent CLI
 * subprocess, so ProcessRunner spawn/exit/timeout/cancellation is the single
 * source of execution liveness, and this heartbeat only reports whether the
 * Runtime process itself is alive and its event loop is turning.
 */
export class RuntimeStatus {
  readonly runtimeId = randomUUID();
  readonly startedAt = new Date().toISOString();
  private heartbeatAt = Date.now();
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  start(intervalMs: number): void {
    if (this.timer) return;
    this.running = true;
    const beat = (): void => {
      this.heartbeatAt = Date.now();
      this.sequence += 1;
    };
    beat();
    this.timer = setInterval(beat, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): RuntimeStatusSnapshot {
    return {
      runtimeId: this.runtimeId,
      startedAt: this.startedAt,
      heartbeatAt: this.heartbeatAt,
      sequence: this.sequence,
      schedulerRunning: this.running,
    };
  }

  isStale(now = Date.now(), windowMs = RUNTIME_HEARTBEAT_WINDOW_MS): boolean {
    return now - this.heartbeatAt > windowMs;
  }
}
