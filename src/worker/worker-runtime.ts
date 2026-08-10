import { ProcessRunner } from "./process-runner.js";
import { WORKER_PROTOCOLS } from "./registry.js";
import type {
  SessionRef, WorkerCall, WorkerProtocol, WorkerResult, WorkerRuntimeConfig, WorkerType,
} from "./types.js";

/** Executes a Worker selected by its caller using only Worker-local configuration. */
export class WorkerRuntime {
  constructor(
    readonly config: WorkerRuntimeConfig,
    private readonly runner = new ProcessRunner(),
    private readonly protocols: Record<WorkerType, WorkerProtocol> = WORKER_PROTOCOLS,
  ) {}

  async execute(
    workerName: string,
    prompt: string,
    timeoutMs: number,
    cwd: string,
    signal?: AbortSignal,
    currentSession?: SessionRef,
    options: { tmpDir?: string; onSpawn?: (pid: number) => void } = {},
  ): Promise<WorkerResult> {
    const config = this.config.workers[workerName];
    if (!config) throw new Error(`worker not found: ${workerName}`);
    const protocol = this.protocols[config.type];
    if (!protocol) throw new Error(`worker protocol not found: ${config.type}`);
    if (currentSession && (currentSession.workerType !== config.type || !protocol.canResume)) {
      throw new Error(`worker cannot resume session: ${workerName}`);
    }
    const call: WorkerCall = { config, prompt, session: currentSession, tmpDir: options.tmpDir };
    const session = protocol.prepareSession ? protocol.prepareSession(call) : call.session;
    const spec = protocol.build(call, session);
    const process = await this.runner.run(spec, cwd, timeoutMs, signal, config.env, options.onSpawn);
    const parsed = protocol.parse(process);
    return { ...process, text: parsed.text, session: parsed.session ?? session };
  }
}
