import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessResult, ProcessSpec, SessionRef, WorkerCall, WorkerProtocol, WorkerType } from "../types.js";
import { jsonLines } from "./shared.js";

const TYPE: WorkerType = "pi";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Resolves the Pi CLI entry from the installed dependency, then launches it
 * through `process.execPath` so Peak never depends on `pi` being on PATH.
 *
 * pi-coding-agent seals its subpaths behind a package "exports" map, so the
 * CLI entry cannot be resolved as a bare subpath (`.../dist/cli.js`). Resolve
 * the package main instead, walk back to its root, and read the published
 * "bin.pi" target. Throws a clear error if Pi is not installed.
 */
function piCliTarget(): [string, string[]] {
  let entry: string;
  try {
    const mainPath = fileURLToPath(import.meta.resolve(PI_PACKAGE));
    const pkgRoot = dirname(dirname(mainPath));
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    const binTarget = pkg.bin?.pi;
    if (!binTarget) throw new Error("missing bin.pi");
    entry = join(pkgRoot, binTarget);
  } catch {
    throw new Error(`pi CLI entry not found; install ${PI_PACKAGE}`);
  }
  return [process.execPath, [entry]];
}

/**
 * Builds the Pi CLI argv from a resolved `[command, commandArgs]` target.
 * Pure and testable: the target is produced by {@link piCliTarget} in
 * production but can be stubbed in tests without Pi installed.
 */
export function buildPiArgv(
  call: WorkerCall,
  session: SessionRef | undefined,
  target: [string, string[]],
): { argv: string[]; input: string; sessionDir: string } {
  const sessionDir = call.sessionDir ?? fallbackSessionDir();
  mkdirSync(sessionDir, { recursive: true });
  const [command, commandArgs] = target;
  const argv = [command, ...commandArgs, "--mode", "json", "--session-dir", sessionDir];
  if (session) argv.push("--session", session.value);
  if (call.config.model) argv.push("--model", call.config.model);
  argv.push("-p");
  return { argv, input: call.prompt, sessionDir };
}

/**
 * Pi CLI protocol. Runs `pi --mode json` so the agent session streams as
 * newline-delimited events; the prompt is piped via stdin (`-p`). Session
 * files live under an isolated `--session-dir` so they never pollute the
 * Board directory; Finalize resume passes the captured session id back with
 * `--session`. Pi itself owns provider auth, model catalogs, and session
 * persistence.
 */
export const piProtocol: WorkerProtocol = {
  type: TYPE,
  canResume: true,
  build(call: WorkerCall, session: SessionRef | undefined): ProcessSpec {
    const { argv, input } = buildPiArgv(call, session, piCliTarget());
    // `pi --mode json` streams one event per token/thinking delta; only the
    // session header and the final agent_end carry what Peak needs. Filtering
    // the rest on the fly keeps a long streaming run well under the bounded
    // stdout capture instead of being misread as runaway output.
    return { argv, input, stdoutFilter: keepPiEvent };
  },
  parse(result: ProcessResult): { text: string; session?: SessionRef } {
    const events = jsonLines(result.stdout);
    const sessionId = events.find((event) => event.type === "session")?.id;
    const sessionRef = typeof sessionId === "string" && sessionId ? { workerType: TYPE, value: sessionId } : undefined;
    return { text: assistantText(events) || result.stdout.trim(), session: sessionRef };
  },
};

/**
 * Extracts the final assistant text from the last `agent_end` event's
 * messages. Mirrors the SDK-era extraction: walk messages in reverse, join the
 * text parts of the last assistant message.
 */
function assistantText(events: Array<Record<string, unknown>>): string {
  for (const event of [...events].reverse()) {
    if (event.type !== "agent_end") continue;
    const messages = (event as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) continue;
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
  }
  return "";
}

/**
 * Retains only the JSONL events pi.parse consumes: the session header (for the
 * resumable id) and agent_end (for the final assistant text). Every streaming
 * delta, tool-progress, and lifecycle event in between is dropped before it
 * reaches the capture buffer.
 */
function keepPiEvent(line: string): boolean {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object") return false;
    const type = (value as { type?: unknown }).type;
    return type === "session" || type === "agent_end";
  } catch {
    return false;
  }
}

/**
 * Defensive fallback session dir (never used in production, where Runtime
 * injects a Project-scoped dir) so a direct protocol call does not write into
 * an arbitrary cwd-derived location.
 */
function fallbackSessionDir(): string {
  const token = randomBytes(8).toString("hex");
  return join(process.cwd(), ".peak-pi-sessions", token);
}
