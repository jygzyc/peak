import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildPermittedTools } from "./permissions.js";
import type { SessionRef, WorkerCall, WorkerDefinition, WorkerResult } from "./types.js";

/**
 * Minimal session surface the driver depends on. Structurally satisfied by
 * the SDK's AgentSession; tests substitute a fake without the SDK (and
 * without provider credentials) through {@link PiSessionFactory}.
 */
export interface PiSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: { type: string; messages?: unknown }) => void): () => void;
  readonly sessionFile: string | undefined;
}

export interface PiSessionRequest {
  /** Session working directory and permission boundary: the per-Project `.tmp`. */
  cwd: string;
  /** Directory holding pi session JSONL files (inside the scratch dir). */
  sessionDir: string;
  config: WorkerDefinition;
  /** Resume an existing session file (Finalize reuses the Execute session). */
  resumeFile?: string;
}

export interface PiSessionFactory {
  createSession(request: PiSessionRequest): Promise<PiSession>;
}

/** The execution surface WorkerRuntime drives; the SDK driver is the default. */
export interface WorkerDriver {
  run(call: WorkerCall, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResult>;
}

/**
 * Creates real pi SDK sessions. The ModelRuntime (model catalogs + provider
 * auth from `~/.pi/agent` and environment variables) is created lazily and
 * shared across sessions; it performs no network refresh on creation.
 */
export class SdkSessionFactory implements PiSessionFactory {
  private runtimePromise?: Promise<ModelRuntime>;

  private modelRuntime(): Promise<ModelRuntime> {
    return (this.runtimePromise ??= ModelRuntime.create({ allowModelNetwork: false }));
  }

  async createSession(request: PiSessionRequest): Promise<PiSession> {
    // The SDK runs in-process, so per-Worker env (e.g. provider API keys from
    // task.json) is applied to this process before auth resolution instead of
    // being injected into a subprocess. These variables never reach the bash
    // tool: its environment is scrubbed separately (see permissions.ts).
    for (const [key, value] of Object.entries(request.config.env)) process.env[key] = value;

    const modelRuntime = await this.modelRuntime();
    let model;
    let thinkingLevel;
    if (request.config.model) {
      const resolved = resolveCliModel({ cliModel: request.config.model, modelRuntime });
      if (resolved.error) throw new Error(`worker model ${request.config.model}: ${resolved.error}`);
      model = resolved.model;
      thinkingLevel = resolved.thinkingLevel;
    }

    const { tools, toolNames } = buildPermittedTools(request.cwd, request.config.permissions);
    // Extensions are disabled outright: the worker's input/output contract is
    // prompt-text in / final-text out, and extensions could register
    // uncontrolled tools. Skills and context files keep loading exactly as
    // they did for the CLI backend (discovery walks up from cwd).
    const resourceLoader = new DefaultResourceLoader({
      cwd: request.cwd,
      extensionsOverride: (base) => ({ ...base, extensions: [] }),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: request.cwd,
      modelRuntime,
      model,
      thinkingLevel,
      tools: toolNames,
      customTools: tools,
      sessionManager: request.resumeFile
        ? SessionManager.open(request.resumeFile)
        : SessionManager.create(request.cwd, request.sessionDir),
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
    });
    return session;
  }
}

/**
 * Runs one Worker call as an in-process pi SDK session. Outcome fields mirror
 * the former subprocess semantics: timeout/cancel map to returncode 1, a
 * session that could not be created reports `started: false`, and the final
 * assistant text of the last `agent_end` event is the only output payload.
 */
export class PiSdkDriver implements WorkerDriver {
  constructor(private readonly factory: PiSessionFactory = new SdkSessionFactory()) {}

  async run(call: WorkerCall, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResult> {
    if (signal?.aborted) {
      return { stdout: "", stderr: "cancelled", returncode: 1, timedOut: false, cancelled: true, started: false, text: "" };
    }
    const sessionDir = join(call.tmpDir ?? cwd, "pi-sessions");
    mkdirSync(sessionDir, { recursive: true });

    let session: PiSession;
    try {
      session = await this.factory.createSession({ cwd, sessionDir, config: call.config, resumeFile: call.session?.value });
    } catch (error) {
      return {
        stdout: "", stderr: errorMessage(error), returncode: 1,
        timedOut: false, cancelled: signal?.aborted ?? false, started: false, text: "",
      };
    }

    let timedOut = false;
    let cancelled = false;
    let lastMessages: unknown;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") lastMessages = event.messages;
    });
    const onExternalAbort = (): void => { cancelled = true; void session.abort(); };
    const timer = setTimeout(() => { timedOut = true; void session.abort(); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    let errorText = "";
    try {
      await session.prompt(call.prompt);
    } catch (error) {
      errorText = errorMessage(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }

    const text = assistantText(lastMessages);
    const sessionFile = session.sessionFile;
    unsubscribe();
    session.dispose();

    const sessionRef: SessionRef | undefined = sessionFile ? { workerType: "pi", value: sessionFile } : undefined;
    return {
      stdout: text,
      stderr: errorText,
      returncode: errorText || timedOut || cancelled ? 1 : 0,
      timedOut,
      cancelled,
      started: true,
      text,
      session: sessionRef,
    };
  }
}

/**
 * Extracts the final assistant text from an `agent_end` event's messages:
 * walk messages in reverse, join the text parts of the last assistant
 * message. Same extraction the CLI JSONL backend used.
 */
export function assistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const text = content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).join("\n").trim();
    if (text) return text;
  }
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
