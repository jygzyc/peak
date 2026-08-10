import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolvedTaskConfig, TaskType, WorkerConfig } from "../dist/utils/types.js";
import { WorkerPool } from "../dist/runtime/worker-pool.js";
import { ProcessRunner } from "../dist/worker/process-runner.js";
import type { ProcessResult, ProcessSpec, WorkerProtocol, WorkerType } from "../dist/worker/types.js";
import { WorkerRuntime } from "../dist/worker/worker-runtime.js";

/** Records specs and resolves a per-call gate that the test releases to model concurrency. */
class GatedRunner extends ProcessRunner {
  readonly specs: ProcessSpec[] = [];
  private readonly gates: Array<{ resolve: () => void }> = [];
  private readonly result: ProcessResult;
  constructor(result: ProcessResult) { super(); this.result = result; }
  override run(spec: ProcessSpec): Promise<ProcessResult> {
    this.specs.push(spec);
    let resolveGate!: () => void;
    const promise = new Promise<void>((resolve) => { resolveGate = resolve; });
    this.gates.push({ resolve: resolveGate });
    return promise.then(() => this.result);
  }
  release(index: number): void { this.gates[index]?.resolve(); }
}

const OK: ProcessResult = { stdout: '{"result":"x"}', stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true };
const FAIL: ProcessResult = { stdout: "", stderr: "boom", returncode: 1, timedOut: false, cancelled: false, started: true };

/** Minimal protocol that records nothing and echoes a fixed session/text. */
function echoProtocol(type: string, canResume: boolean): WorkerProtocol {
  return {
    type: type as never, canResume,
    build(): ProcessSpec { return { argv: ["x"], input: "p" }; },
    parse(result: ProcessResult): { text: string } { return { text: result.stdout }; },
  };
}

function worker(type: string, taskTypes: TaskType[], maxRunning: number, priority = 1): WorkerConfig {
  return { type: type as never, taskTypes, maxRunning, priority, env: {} };
}

function config(workers: Record<string, WorkerConfig>): ResolvedTaskConfig {
  return {
    configPath: "/t.json", taskDir: "/",
    board: { skills: [], projects: [{ source: "start", goal: "done" }] },
    workers,
    scheduler: { maxRunningProjects: 4, intervalMs: 3_000 },
    phase: { plan: {}, supervise: { intervalMs: 1_000 }, execute: { maxArtifactBytes: 1024, customProfile: [] } },
  };
}

function runtime(
  value: ResolvedTaskConfig,
  runner: ProcessRunner,
  protocols: Partial<Record<WorkerType, WorkerProtocol>>,
): WorkerRuntime {
  return new WorkerRuntime({
    workers: Object.fromEntries(Object.entries(value.workers).map(([name, item]) => [name, {
      type: item.type, model: item.model, env: item.env,
    }])),
  }, runner, protocols as Record<WorkerType, WorkerProtocol>);
}

test("ProcessRunner pins cwd and conventional temp variables to Project scratch", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "peak-worker-cwd-"));
  try {
    const script = "process.stdout.write(JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD,tmpdir:process.env.TMPDIR,tmp:process.env.TMP,temp:process.env.TEMP}))";
    const result = await new ProcessRunner().run({ argv: [process.execPath, "-e", script] }, scratch, 5_000);
    assert.equal(result.returncode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: scratch, pwd: scratch, tmpdir: scratch, tmp: scratch, temp: scratch,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("executeCapacity = sum of execute Worker maxRunning", async () => {
  const c = config({ a: worker("pi", ["execute"], 2), b: worker("codex", ["execute"], 3), s: worker("pi", ["supervise"], 1) });
  const pool = new WorkerPool(c, runtime(c, new ProcessRunner(), { pi: echoProtocol("pi", true), codex: echoProtocol("codex", false) }));
  assert.equal(pool.pick("execute"), "a");
  pool.release("a", "execute");
  // supervise worker never selectable for execute even when idle.
  assert.notEqual(pool.pick("execute"), "s");
});

test("maxRunning=1 blocks a second concurrent Execute on the same Worker", async () => {
  const c = config({ solo: worker("pi", ["plan", "supervise", "execute"], 1) });
  const runner = new GatedRunner(OK);
  const pool = new WorkerPool(c, runtime(c, runner, { pi: echoProtocol("pi", true) }));
  const first = pool.pick("execute");
  assert.equal(first, "solo");
  // reservation consumes the single slot; second pick must fail before execute starts.
  assert.equal(pool.pick("execute"), undefined);
  const running = pool.execute(first!, "execute", "p", 1_000, "/");
  // while running, still blocked
  assert.equal(pool.pick("execute"), undefined);
  runner.release(0);
  await running;
  // after completion the slot frees
  assert.equal(pool.pick("execute"), "solo");
  pool.release("solo", "execute");
});

test("Plan, Supervise and Execute can be reserved concurrently on one Worker", () => {
  // One Worker with maxRunning 1 supporting all three phases: Plan + Supervise
  // + Execute each take their own reservation (control channels do not consume
  // Execute capacity), so all three picks succeed.
  const c = config({ solo: worker("pi", ["plan", "supervise", "execute"], 1) });
  const pool = new WorkerPool(c, runtime(c, new ProcessRunner(), { pi: echoProtocol("pi", true) }));
  assert.equal(pool.pick("plan"), "solo");
  assert.equal(pool.pick("supervise"), "solo");
  assert.equal(pool.pick("execute"), "solo");
  // a second execute on the same Worker is blocked
  assert.equal(pool.pick("execute"), undefined);
  pool.release("solo", "plan");
  pool.release("solo", "supervise");
  pool.release("solo", "execute");
});

test("a failed started Execute puts the Worker on a 30s cooldown", async () => {
  const c = config({ solo: worker("pi", ["execute"], 1) });
  const runner = new GatedRunner(FAIL);
  const pool = new WorkerPool(c, runtime(c, runner, { pi: echoProtocol("pi", true) }));
  const name = pool.pick("execute")!;
  const result = pool.execute(name, "execute", "p", 1_000, "/");
  runner.release(0);
  const finished = await result;
  assert.equal(finished.returncode, 1);
  assert.equal(pool.pick("execute"), undefined, "Worker is cooling down immediately after failure");
});
