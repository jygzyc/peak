import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_WORKER_PERMISSIONS } from "../../dist/worker/permissions.js";
import { PiSdkDriver, assistantText, type PiSession, type PiSessionFactory, type PiSessionRequest } from "../../dist/worker/pi-sdk.js";
import type { SessionRef, WorkerCall, WorkerDefinition } from "../../dist/worker/types.js";

/**
 * In-memory PiSession: when `endMessages` is set, `prompt` emits the
 * `agent_end` event before resolving (the driver's listener is already
 * registered by then); in hang mode `prompt` stays pending until `abort()`
 * is called, mirroring how the real session unwinds on abort.
 */
class FakeSession implements PiSession {
  readonly listeners: Array<(event: { type: string; messages?: unknown }) => void> = [];
  readonly prompts: string[] = [];
  aborts = 0;
  disposed = 0;
  readonly sessionFile: string | undefined;
  private readonly hang: boolean;
  private readonly endMessages: unknown;
  private releasePrompt?: () => void;
  constructor(sessionFile: string | undefined, options: { hang?: boolean; endMessages?: unknown } = {}) {
    this.sessionFile = sessionFile;
    this.hang = options.hang ?? false;
    this.endMessages = options.endMessages;
  }
  prompt(text: string): Promise<void> {
    this.prompts.push(text);
    if (this.endMessages !== undefined) this.emit({ type: "agent_end", messages: this.endMessages });
    if (!this.hang) return Promise.resolve();
    return new Promise((resolve) => { this.releasePrompt = resolve; });
  }
  abort(): Promise<void> {
    this.aborts += 1;
    this.releasePrompt?.();
    return Promise.resolve();
  }
  dispose(): void { this.disposed += 1; }
  subscribe(listener: (event: { type: string; messages?: unknown }) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners.splice(this.listeners.indexOf(listener), 1); };
  }
  private emit(event: { type: string; messages?: unknown }): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

class FakeFactory implements PiSessionFactory {
  readonly requests: PiSessionRequest[] = [];
  session?: FakeSession;
  error?: Error;
  private readonly options: { hang?: boolean; sessionFile?: string; endMessages?: unknown };
  constructor(options: { hang?: boolean; sessionFile?: string; endMessages?: unknown } = {}) { this.options = options; }
  createSession(request: PiSessionRequest): Promise<PiSession> {
    this.requests.push(request);
    if (this.error) return Promise.reject(this.error);
    const sessionFile = "sessionFile" in this.options ? this.options.sessionFile : join(request.sessionDir, "session.jsonl");
    this.session = new FakeSession(sessionFile, { hang: this.options.hang, endMessages: this.options.endMessages });
    return Promise.resolve(this.session);
  }
}

function definition(): WorkerDefinition {
  return { type: "pi", env: {}, permissions: { ...DEFAULT_WORKER_PERMISSIONS } };
}

function call(overrides: Partial<WorkerCall> = {}): WorkerCall {
  return { config: definition(), prompt: "do the work", ...overrides };
}

test("the prompt is passed through and the final assistant text becomes the result", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-pi-sdk-"));
  try {
    const factory = new FakeFactory({ endMessages: [
      { role: "user", content: [{ type: "text", text: "do the work" }] },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "final" }, { type: "text", text: "answer" }] },
    ] });
    const result = await new PiSdkDriver(factory).run(call(), root, 5_000);
    const session = factory.session!;
    assert.equal(factory.requests[0]?.sessionDir, join(root, "pi-sessions"));
    assert.equal(factory.requests[0]?.cwd, root);
    assert.deepEqual(session.prompts, ["do the work"]);
    assert.equal(result.returncode, 0);
    assert.equal(result.started, true);
    assert.equal(result.text, "final\nanswer");
    assert.equal(result.stdout, "final\nanswer");
    assert.deepEqual(result.session, { workerType: "pi", value: session.sessionFile });
    assert.equal(session.disposed, 1, "the session is disposed after the run");
    assert.equal(session.listeners.length, 0, "the driver unsubscribes after the run");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assistantText handles non-arrays, missing assistants, and part joining", () => {
  assert.equal(assistantText(undefined), "");
  assert.equal(assistantText("not an array"), "");
  assert.equal(assistantText([{ role: "user", content: [{ type: "text", text: "hi" }] }]), "");
  assert.equal(assistantText([
    { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
  ]), "", "an assistant message without text parts yields nothing");
  assert.equal(assistantText([
    { role: "assistant", content: [{ type: "text", text: "older" }] },
    { role: "assistant", content: [{ type: "text", text: "  a " }, { type: "text", text: "b" }] },
  ]), "a \nb", "the last assistant message wins; parts join with newlines and the whole string trims");
});

test("a session without a sessionFile leaves result.session undefined", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-pi-sdk-"));
  try {
    const factory = new FakeFactory({ sessionFile: undefined });
    const result = await new PiSdkDriver(factory).run(call(), root, 5_000);
    assert.equal(result.session, undefined);
    assert.equal(result.returncode, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a resumed session is forwarded to the factory as resumeFile", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-pi-sdk-"));
  try {
    const factory = new FakeFactory();
    const session: SessionRef = { workerType: "pi", value: join(root, "previous.jsonl") };
    await new PiSdkDriver(factory).run(call({ session }), root, 5_000);
    assert.equal(factory.requests[0]?.resumeFile, session.value);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a hung prompt times out: timedOut, returncode 1, and session.abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-pi-sdk-"));
  try {
    const factory = new FakeFactory({ hang: true });
    const result = await new PiSdkDriver(factory).run(call(), root, 50);
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.returncode, 1);
    assert.equal(result.started, true);
    assert.ok(factory.session!.aborts >= 1, "the driver aborts the session on timeout");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an external AbortSignal cancels the run and aborts the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-pi-sdk-"));
  try {
    const factory = new FakeFactory({ hang: true });
    const controller = new AbortController();
    const run = new PiSdkDriver(factory).run(call(), root, 60_000, controller.signal);
    // Abort after the driver has created the session and registered its
    // listener (an abort racing session creation is not observable by it).
    setImmediate(() => controller.abort());
    const result = await run;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.returncode, 1);
    assert.ok(factory.session!.aborts >= 1, "the driver aborts the session on cancellation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a pre-aborted signal never creates a session", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-pi-sdk-"));
  try {
    const factory = new FakeFactory();
    const controller = new AbortController();
    controller.abort();
    const result = await new PiSdkDriver(factory).run(call(), root, 5_000, controller.signal);
    assert.equal(result.started, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.returncode, 1);
    assert.equal(factory.requests.length, 0, "no session is created");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a factory failure reports started:false with the error on stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-pi-sdk-"));
  try {
    const factory = new FakeFactory();
    factory.error = new Error("no provider credentials");
    const result = await new PiSdkDriver(factory).run(call(), root, 5_000);
    assert.equal(result.started, false);
    assert.equal(result.returncode, 1);
    assert.equal(result.cancelled, false);
    assert.match(result.stderr, /no provider credentials/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
