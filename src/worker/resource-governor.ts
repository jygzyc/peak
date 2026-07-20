/** Process-wide FIFO permit governor for actual worker executions.
 *
 * GlobalSupervisor owns one instance and injects it into every registered
 * SessionLoop (and its MetacogSupervisor). Session tick concurrency is only a
 * scheduling optimization; this semaphore is the resource boundary that stops
 * a single tick from spawning more workers than the global quota permits.
 */
import type { WorkerPool, WorkerRequest, WorkerResult } from "./worker-runtime.js";
import type { TaskConfig, WorkerName } from "../agent/types.js";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class GlobalResourceGovernor {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly wrappers = new WeakMap<WorkerPool, WorkerPool>();

  constructor(readonly maxConcurrent: number) {
    if (maxConcurrent !== Infinity && (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0)) {
      throw new Error("global worker concurrency must be a positive integer or Infinity");
    }
  }

  get activeCount(): number { return this.active; }
  get pendingCount(): number { return this.waiters.length; }

  wrap(pool: WorkerPool): WorkerPool {
    const existing = this.wrappers.get(pool);
    if (existing) return existing;
    const wrapped = new GovernedWorkerPool(pool, this);
    this.wrappers.set(pool, wrapped);
    return wrapped;
  }

  async execute<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(asAbortError(signal));
    }
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(asAbortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.reject(asAbortError(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseOnce());
    }
  }
}

class GovernedWorkerPool implements WorkerPool {
  constructor(
    private readonly inner: WorkerPool,
    private readonly governor: GlobalResourceGovernor,
  ) {}

  execute(request: WorkerRequest): Promise<WorkerResult> {
    return this.governor.execute(request.signal, () => this.inner.execute(request));
  }

  pickWorker(config: TaskConfig, candidates?: WorkerName[]): WorkerName {
    return this.inner.pickWorker(config, candidates);
  }
}

function asAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason ? String(signal.reason) : "worker permit wait cancelled");
}
