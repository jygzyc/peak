/**
 * AgentDriverPool — production WorkerPool backed by CLI/model backends.
 *
 * Wraps the AgentDriver / AgentBackend / ModelProvider machinery. Stages call
 * WorkerPool.execute(); this pool translates that into a backend invocation.
 *   - Worker-pool semantics (pickWorker / runningCount)
 *   - Heterogeneous engine preference (rotate through configured workers)
 *   - Per-project running-worker tracking
 */

import type { ProjectId, TaskConfig, WorkerConfig, WorkerName } from "../agent/types.js";
import type { WorkerPool, WorkerRequest, WorkerResult } from "./worker-runtime.js";
import { executeWorker } from "./registry.js";

export class AgentDriverPool implements WorkerPool {
  private runningPerProject = new Map<ProjectId, Set<string>>();
  private workerPickCounter = 0;

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    if (!request.workerName || !request.role || !request.projectId || !request.cwd) {
      throw new Error("worker request requires workerName, role, projectId, and cwd");
    }
    const config = request.config;
    const backendConfig = {
      kind: config.kind === "mock" ? "agent" : (config.kind as "agent" | "api"),
      backend: config.backend,
      transport: config.transport,
      command: config.command,
      args: config.args,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      apiKeyEnv: config.apiKeyEnv,
      password: config.password,
      provider: config.provider,
      maxTokens: request.maxOutputTokens ?? config.maxTokens,
      temperature: config.temperature,
      timeoutMs: config.timeoutMs,
    } as const;

    const workerName = request.workerName;
    this.markRunning(request.projectId, workerName);
    const result = await Promise.resolve(executeWorker({
      worker: workerName,
      role: request.role,
      projectId: request.projectId,
      sessionDir: request.cwd,
      prompt: request.prompt,
      config: backendConfig,
      cwd: request.cwd,
      sessionId: request.sessionId,
      conclude: request.conclude,
      signal: request.signal,
    })).finally(() => {
      this.unmarkRunning(request.projectId, workerName);
    });

    return {
      workerId: workerName,
      text: result.stdout,
      returncode: result.returncode,
      stderr: result.stderr,
      sessionId: result.sessionId,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }

  pickWorker(projectId: ProjectId, config: TaskConfig, allowed?: WorkerName[]): WorkerName {
    const candidates = (allowed?.length ? allowed : Object.keys(config.workers))
      .filter((name) => config.workers[name]);
    if (candidates.length === 0) return "noop";

    // Heterogeneous preference: pick the first worker not currently running
    // for this project. If all are running, round-robin.
    const running = this.runningPerProject.get(projectId);
    if (running && running.size > 0) {
      const idle = candidates.find((w) => !running.has(w));
      if (idle) return idle;
    }
    return candidates[this.workerPickCounter++ % candidates.length];
  }

  runningCount(projectId: ProjectId): number {
    return this.runningPerProject.get(projectId)?.size ?? 0;
  }

  /** Mark a worker as running for a project (called by sessionLoop). */
  markRunning(projectId: ProjectId, workerId: string): void {
    let s = this.runningPerProject.get(projectId);
    if (!s) {
      s = new Set();
      this.runningPerProject.set(projectId, s);
    }
    s.add(workerId);
  }

  /** Mark a worker as no longer running. */
  unmarkRunning(projectId: ProjectId, workerId: string): void {
    this.runningPerProject.get(projectId)?.delete(workerId);
  }
}
