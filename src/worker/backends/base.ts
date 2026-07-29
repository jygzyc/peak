import type { WorkerType } from "../../config/types.js";
import { ProcessRunner } from "../process-runner.js";
import type {
  ProcessResult,
  ProcessSpec,
  SessionRef,
  WorkerDriver,
  WorkerRequest,
  WorkerResult,
} from "../types.js";

export abstract class CliWorkerDriver implements WorkerDriver {
  abstract readonly type: WorkerType;
  abstract readonly canResume: boolean;

  constructor(private readonly runner = new ProcessRunner()) {}

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    const preparedSession = this.prepareSession(request);
    const process = await this.runner.run(
      this.build(request, preparedSession),
      request.cwd,
      request.timeoutMs,
      request.signal,
    );
    const parsed = this.parse(process);
    return {
      ...process,
      text: parsed.text,
      session: parsed.session ?? preparedSession,
    };
  }

  dispose(): void {}

  protected prepareSession(request: WorkerRequest): SessionRef | undefined {
    return request.session;
  }

  protected abstract build(request: WorkerRequest, session: SessionRef | undefined): ProcessSpec;
  protected abstract parse(result: ProcessResult): { text: string; session?: SessionRef };
}

export function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
    } catch { return []; }
  });
}

export function textFromJson(stdout: string): string {
  const events = jsonLines(stdout);
  for (const event of [...events].reverse()) {
    for (const key of ["text", "content", "result", "message"]) {
      if (typeof event[key] === "string") return event[key].trim();
    }
  }
  return stdout.trim();
}

export function session(type: WorkerType, value: unknown): SessionRef | undefined {
  return typeof value === "string" && value ? { workerType: type, value } : undefined;
}
