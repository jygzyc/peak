/**
 * MockWorker — testing-only WorkerPool implementation.
 *
 * Returns canned responses by regex match against the prompt. Falls through
 * to a failure result if no pattern matches. Used in every Stage unit test
 * and in the e2e pipeline test.
 *
 * `registerDefaults()` wires a self-contained end-to-end mock scenario
 * (planner → explorer → evaluator → verified fact) keyed off the builtin
 * prompt headers, so `peak run --mock` exercises the full loop without any
 * real backend. This is runtime *mechanism* (a ready-made WorkerPool), not
 * domain policy — it carries no business semantics.
 */

import type { ProjectId, TaskConfig, WorkerName } from "../agent/types.js";
import type { WorkerPool, WorkerRequest, WorkerResult } from "./worker-runtime.js";

type ResponseSpec = string | ((request: WorkerRequest) => string | Promise<string>);

interface MockEntry {
  pattern: RegExp;
  response: ResponseSpec;
  returncode: number;
}

export class MockWorker implements WorkerPool {
  private entries: MockEntry[] = [];
  private callLog: Array<{ prompt: string; text: string; workerName?: string; cwd?: string }> = [];

  register(pattern: RegExp, response: ResponseSpec, returncode = 0): this {
    this.entries.unshift({ pattern, response, returncode });
    return this;
  }

  /**
   * Register a canned scenario that drives the builtin loop to completion:
   * planner opens one intent, explorer resolves it to a candidate fact,
   * evaluator accepts it. Keyed off the builtin prompt headers
   * ("automated planning module" / "Explorer Role" / "Evaluator Role") so the
   * patterns are mutually exclusive and match regardless of which intent text
   * or fact the loop happens to pass through.
   *
   * The planner responds once with a new intent; if invoked again (empty
   * intents + a recent accept verdict), it concludes the run so the loop
   * terminates naturally.
   */
  registerDefaults(): this {
    let plannerInvoked = false;
    this.register(
      /automated planning module/i,
      () => {
        if (plannerInvoked) {
          return envelope("decisions", {
            createIntents: [],
            stopExplorerIntentIds: [],
            failIntents: [],
            consumeHints: [],
            concludeRun: { description: "mock goal reached" },
          });
        }
        plannerInvoked = true;
        return envelope("decisions", {
          createIntents: [{
            description: "MOCK-INTENT: inspect the target's entry point",
            from: [],
            priority: 1,
            dispatchExplorer: true,
          }],
          dispatchExplorerIntentIds: [],
          stopExplorerIntentIds: [],
          failIntents: [],
          consumeHints: [],
          concludeRun: null,
        });
      },
    );
    this.register(
      /# Explorer Role/i,
      envelope("fact", {
        description: "MOCK FACT: target exposes an entry point",
        evidence: ["mock-evidence: entry point located"],
        confidence: 0.9,
      }),
    );
    this.register(
      /Evaluator Role/i,
      envelope("verdict", { decision: "pass", reason: "mock acceptance" }),
    );
    return this;
  }

  reset(): this {
    this.entries = [];
    this.callLog = [];
    return this;
  }

  calls(): Array<{ prompt: string; text: string; workerName?: string; cwd?: string }> {
    return [...this.callLog];
  }

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    if (request.signal?.aborted) {
      return { workerId: "mock", text: "", returncode: 1, stderr: "mock worker cancelled", aborted: true };
    }
    for (const entry of this.entries) {
      if (entry.pattern.test(request.prompt)) {
        const raw: string | Promise<string> = typeof entry.response === "function"
          ? entry.response(request)
          : entry.response;
        const text = await abortable(raw, request.signal);
        this.callLog.push({ prompt: request.prompt, text, workerName: request.workerName, cwd: request.cwd });
        return { workerId: "mock", text, returncode: entry.returncode };
      }
    }
    const stderr = `no mock match for prompt: ${request.prompt.slice(0, 100)}`;
    this.callLog.push({ prompt: request.prompt, text: "", workerName: request.workerName, cwd: request.cwd });
    return { workerId: "mock", text: "", returncode: 1, stderr };
  }

  pickWorker(projectId: ProjectId, config: TaskConfig, allowed?: WorkerName[]): WorkerName {
    const candidates = (allowed?.length ? allowed : Object.keys(config.workers))
      .filter((name) => config.workers[name]);
    return candidates[0] ?? "mock";
  }

  runningCount(_projectId: ProjectId): number { return 0; }
}

async function abortable(value: string | Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return Promise.resolve(value);
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : new Error("mock worker cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/** Build a `{kind, data}` worker envelope string — the shape contracts expect. */
function envelope(kind: string, data: unknown): string {
  return JSON.stringify({ kind, data });
}
