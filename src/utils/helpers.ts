/**
 * Shared helper collection: the Project audit-log append, the UI-only source
 * title derivation, and the JSON request/response primitives used by the
 * Graph HTTP server and every API extension.
 */
import { appendFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { initializeProjectLogsDirectory } from "./paths.js";

/**
 * Generic HTTP/serialization primitives shared by the Graph server, the
 * Runtime, and the server-side control-plane extensions. They live in utils
 * (not graph/) so the Runtime never imports a server module for them.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function localTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function toJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Appends one JSON line to a Project's `logs/main.log` in the same format as
 * Graph events (`{ at, type, ...data }`). This is the single source for the
 * audit-log write used by the Graph HTTP server and Runtime
 * executors — they must all produce identical lines.
 */
export function writeProjectLog(projectDir: string, type: string, data: Record<string, unknown>): void {
  const logs = initializeProjectLogsDirectory(projectDir);
  appendFileSync(join(logs, "main.log"), `${JSON.stringify({ at: localTimestamp(), type, ...data })}\n`);
}

/**
 * Derives the short UI-only Project title from its immutable source: the first
 * 1021 UTF-8 bytes followed by `...` when the source exceeds the 1 KiB Fact
 * description limit. The complete immutable source always lives in the origin
 * Fact; this is only a label. Shared by Runtime creation and Docker task launch
 * so both produce identical titles.
 */
export function sourceTitle(source: string): string {
  if (Buffer.byteLength(source, "utf8") <= 1024) return source;
  let result = "";
  let bytes = 0;
  for (const character of source) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > 1021) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}...`;
}

/** Maximum accepted request body size (applies to every JSON endpoint). */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Reads and parses one JSON object request body. Bodies larger than 1 MiB are
 * rejected with 413. The Graph HTTP server and every API
 * extension share this single implementation.
 */
export async function bodyObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new ApiError(413, "request body too large");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ApiError(400, "invalid JSON body"); }
}

/** Writes a JSON response with no-store caching. */
export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/**
 * Rejects unknown or missing required fields. `optional` fields may be absent
 * but, when present, must still be in `allowed`. Throws `ApiError(400, ...)`
 * — for the worker-contract path (plain `Error`) use the contracts module.
 */
export function exact(value: Record<string, unknown>, allowed: string[], optional: string[] = []): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  const missing = allowed.find((key) => !optional.includes(key) && !(key in value));
  if (unknown || missing) throw new ApiError(400, unknown ? `unknown field: ${unknown}` : `missing field: ${missing}`);
}

/** Writes an empty response with the given status. */
export function empty(response: ServerResponse, status: number): void {
  response.writeHead(status);
  response.end();
}

/** True for IPv4/IPv6 loopback and localhost. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
