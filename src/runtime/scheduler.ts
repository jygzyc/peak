import type { SchedulerConfig } from "../config/types.js";
import { ProjectLoop } from "../project/project-loop.js";
import { ExecutionRegistry } from "./execution-registry.js";

export class RuntimeScheduler {
  private readonly loops = new Map<string, ProjectLoop>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private cursor = 0;

  constructor(private readonly config: SchedulerConfig, readonly executions: ExecutionRegistry) {}
  add(loop: ProjectLoop): void { this.loops.set(loop.projectId, loop); }
  remove(projectId: string): void { this.executions.cancelProject(projectId); this.loops.delete(projectId); }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.executions.cancelAll();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let slots = Math.max(0, this.config.maxConcurrent - this.executions.count());
      const all = [...this.loops.values()];
      if (all.length === 0) return;
      const loops = [...all.slice(this.cursor), ...all.slice(0, this.cursor)].slice(0, this.config.maxRunningProjects);
      this.cursor = (this.cursor + loops.length) % all.length;
      for (const loop of loops) {
        if (slots === 0) break;
        slots -= await loop.tick(slots);
      }
    } finally { this.ticking = false; }
  }
}
