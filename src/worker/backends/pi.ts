import {
  type AgentSession,
  createAgentSession,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { DirectWorkerDriver, SessionRef, WorkerRequest, WorkerResult } from "../types.js";

const SESSION_TTL_MS = 10 * 60_000;

interface RetainedSession {
  session: AgentSession;
  timer: NodeJS.Timeout;
}

export class PiDriver implements DirectWorkerDriver {
  readonly type = "pi";
  readonly canResume = true;
  private readonly sessions = new Map<string, RetainedSession>();
  private modelRuntime?: Promise<ModelRuntime>;

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    const { config, taskType, prompt, timeoutMs, cwd, signal, session: currentSession } = request;
    if (signal?.aborted) return failure("cancelled", false, false, true);
    if (config.args.length) return failure("pi worker args are not supported by the Pi Agent SDK", false);

    let session: AgentSession | undefined;
    let warning = "";
    try {
      if (currentSession) {
        const retained = this.sessions.get(currentSession.value);
        if (!retained) return failure(`pi session is no longer available: ${currentSession.value}`, false);
        clearTimeout(retained.timer);
        this.sessions.delete(currentSession.value);
        session = retained.session;
      } else {
        const modelRuntime = await this.getModelRuntime();
        const selected = config.model
          ? resolveCliModel({ cliModel: config.model, modelRuntime })
          : undefined;
        if (selected?.error) return failure(selected.error, false);
        warning = selected?.warning ?? "";
        ({ session } = await createAgentSession({
          cwd,
          model: selected?.model,
          thinkingLevel: selected?.thinkingLevel,
          modelRuntime,
          sessionManager: SessionManager.inMemory(cwd),
        }));
      }
    } catch (error) {
      return failure(errorMessage(error), false);
    }

    let text = "";
    let streamed = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        streamed += event.assistantMessageEvent.delta;
      } else if (event.type === "agent_end") {
        text = assistantText(event.messages) || text;
      }
    });
    let timedOut = false;
    let cancelled = false;
    const stopSession = (): void => { void session.abort().catch(() => undefined); };
    const abort = (): void => {
      cancelled = true;
      stopSession();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopSession();
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });

    let error = "";
    try {
      await session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
      error = session.agent.state.errorMessage ?? "";
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      unsubscribe();
    }

    text ||= streamed.trim();
    const resumable = taskType === "execute" && !cancelled && (timedOut || !error);
    const sessionRef = resumable ? this.retain(session) : undefined;
    if (!resumable) session.dispose();
    const stderr = [warning, error].filter(Boolean).join("\n");
    return {
      text,
      stdout: text,
      stderr,
      returncode: timedOut || cancelled || error ? 1 : 0,
      timedOut,
      cancelled,
      started: true,
      session: sessionRef,
    };
  }

  dispose(): void {
    for (const retained of this.sessions.values()) {
      clearTimeout(retained.timer);
      retained.session.dispose();
    }
    this.sessions.clear();
  }

  private retain(session: AgentSession): SessionRef {
    const id = session.sessionId;
    const timer = setTimeout(() => {
      const retained = this.sessions.get(id);
      if (retained?.session !== session) return;
      this.sessions.delete(id);
      session.dispose();
    }, SESSION_TTL_MS);
    timer.unref?.();
    this.sessions.set(id, { session, timer });
    return { workerType: "pi", value: id };
  }

  private getModelRuntime(): Promise<ModelRuntime> {
    return this.modelRuntime ??= ModelRuntime.create();
  }
}

function assistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).join("\n").trim();
  }
  return "";
}

function failure(stderr: string, started: boolean, timedOut = false, cancelled = false): WorkerResult {
  return { text: "", stdout: "", stderr, returncode: 1, timedOut, cancelled, started };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
