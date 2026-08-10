import type { SessionRef, WorkerType } from "../types.js";

/** Parses stdout as newline-delimited JSON objects, skipping non-JSON lines. */
export function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
    } catch { return []; }
  });
}

/**
 * Best-effort text extraction for JSONL CLI output: scans events in reverse
 * for the first string field under a conventional key, falling back to raw
 * stdout. Used only when a tool does not provide a more specific parser.
 */
export function textFromJson(stdout: string): string {
  const events = jsonLines(stdout);
  for (const event of [...events].reverse()) {
    for (const key of ["text", "content", "result", "message"]) {
      if (typeof event[key] === "string") return event[key] as string;
    }
  }
  return stdout.trim();
}

export function session(type: WorkerType, value: unknown): SessionRef | undefined {
  return typeof value === "string" && value ? { workerType: type, value } : undefined;
}
