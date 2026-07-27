export class GraphSupervisor {
  private nextAt = 0;
  constructor(readonly intervalMs: number) {}
  due(now = Date.now()): boolean { return now >= this.nextAt; }
  mark(now = Date.now()): void { this.nextAt = now + this.intervalMs; }
}
