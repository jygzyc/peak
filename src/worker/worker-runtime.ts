import { PiSdkDriver, type WorkerDriver } from "./pi-sdk.js";
import type { SessionRef, WorkerCall, WorkerResult, WorkerRuntimeConfig } from "./types.js";

/** Executes a Worker selected by its caller using only Worker-local configuration. */
export class WorkerRuntime {
  constructor(
    readonly config: WorkerRuntimeConfig,
    private readonly driver: WorkerDriver = new PiSdkDriver(),
  ) {}

  async execute(
    workerName: string,
    prompt: string,
    timeoutMs: number,
    cwd: string,
    signal?: AbortSignal,
    currentSession?: SessionRef,
    options: { tmpDir?: string } = {},
  ): Promise<WorkerResult> {
    const config = this.config.workers[workerName];
    if (!config) throw new Error(`worker not found: ${workerName}`);
    if (currentSession && currentSession.workerType !== config.type) {
      throw new Error(`worker cannot resume session: ${workerName}`);
    }
    const call: WorkerCall = { config, prompt, session: currentSession, tmpDir: options.tmpDir };
    return this.driver.run(call, cwd, timeoutMs, signal);
  }
}
