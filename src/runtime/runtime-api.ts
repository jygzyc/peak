import type { ServerResponse } from "node:http";
import type { ApiExtension } from "../graph/http-server.js";
import type { ExecutionRegistry, ExecutionSnapshot } from "./execution-registry.js";
import { type RuntimeStatus, RUNTIME_HEARTBEAT_WINDOW_MS } from "./runtime-status.js";

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/**
 * `GET /api/runtime/status` — reports Runtime liveness. When no Runtime is
 * attached (peak serve), the extension is never injected and the route falls
 * through to the Graph 404, which the Dashboard treats as a normal downgrade.
 */
export function runtimeStatusExtension(status: RuntimeStatus): ApiExtension {
  return {
    matches(method, parts): boolean {
      return method === "GET" && parts.length === 3 && parts[1] === "runtime" && parts[2] === "status";
    },
    async handle(_request, response): Promise<boolean> {
      json(response, { ...status.snapshot(), heartbeatWindowMs: RUNTIME_HEARTBEAT_WINDOW_MS });
      return true;
    },
  };
}

/**
 * `GET /api/runtime/projects/{projectId}/executions` — immutable in-flight
 * execution snapshots for one Project. Empty array when nothing is running.
 */
export function runtimeExecutionsExtension(executions: ExecutionRegistry): ApiExtension {
  return {
    matches(method, parts): boolean {
      return method === "GET" && parts.length === 5 && parts[1] === "runtime" && parts[2] === "projects"
        && parts[4] === "executions";
    },
    async handle(request, response): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const projectId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[3] ?? "");
      if (!projectId) { json(response, [] as ExecutionSnapshot[], 200); return true; }
      json(response, executions.snapshot(projectId));
      return true;
    },
  };
}

/** Convenience bundle of both Runtime read-only extensions. */
export function runtimeExtensions(status: RuntimeStatus, executions: ExecutionRegistry): ApiExtension[] {
  return [runtimeStatusExtension(status), runtimeExecutionsExtension(executions)];
}
