import type { ResolvedTaskConfig } from "../config/types.js";
import { ProjectLoop } from "../project/project-loop.js";
import { ExecutionRegistry } from "./execution-registry.js";

export class RuntimeScheduler {
  private readonly loops = new Map<string, ProjectLoop>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private cursor = 0;

  constructor(private readonly config: ResolvedTaskConfig, readonly executions: ExecutionRegistry) {}
  add(loop: ProjectLoop): void { this.loops.set(loop.projectId, loop); }
  remove(projectId: string): void {
    this.loops.get(projectId)?.dispose();
    this.loops.delete(projectId);
  }

  start(): void {
    if (this.timer) return;
    // Absorb per-tick failures (e.g. a tick racing shutdown against a closed
    // Graph server) so they cannot surface as unhandled rejections.
    const safeTick = (): void => {
      void this.tick().catch((error: unknown) => {
        process.stderr.write(`[peak] scheduler tick failed: ${(error as Error).message}\n`);
      });
    };
    safeTick();
    this.timer = setInterval(safeTick, this.config.scheduler.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const loop of this.loops.values()) loop.dispose();
    this.executions.cancelAll();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const all = [...this.loops.values()];
      if (all.length === 0) return;
      const loops = [...all.slice(this.cursor), ...all.slice(0, this.cursor)].slice(0, this.config.scheduler.maxRunningProjects);
      this.cursor = (this.cursor + loops.length) % all.length;
      // Execute capacity is enforced per Project by each ProjectLoop against its
      // own in-flight count; Projects never share or consume each other's budget.
      for (const loop of loops) await loop.tick();
    } finally { this.ticking = false; }
  }
}
