import type { SessionRef, WorkerDriver } from "../types.js";

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

export function session(type: WorkerDriver["type"], value: unknown): SessionRef | undefined {
  return typeof value === "string" && value ? { workerType: type, value } : undefined;
}
