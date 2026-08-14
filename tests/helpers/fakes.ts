import type { TestContext } from "node:test";
import type { GraphClient } from "../../dist/graph/graph-client.js";
import type { ProcessResult, ProcessSpec, WorkerRunner } from "../../dist/worker/types.js";

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type FetchStubHandler = (call: FetchCall) => Response | Promise<Response>;

/**
 * Replaces global fetch for the duration of one test and records every call
 * so tests can assert on method, URL, headers, and serialized body.
 */
export function stubFetch(t: TestContext, handler: FetchStubHandler): FetchCall[] {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

export function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export interface RecordedRun { spec: ProcessSpec; cwd: string; timeoutMs: number }

/**
 * A WorkerRunner stub that records runs and resolves with a fixed result or
 * the value produced by a per-call handler. Inject into WorkerRuntime.
 */
export function fakeWorkerRunner(result: ProcessResult | ((spec: ProcessSpec) => ProcessResult | Promise<ProcessResult>)): {
  runner: WorkerRunner;
  runs: RecordedRun[];
} {
  const runs: RecordedRun[] = [];
  const runner: WorkerRunner = {
    run(spec: ProcessSpec, cwd: string, timeoutMs: number): Promise<ProcessResult> {
      runs.push({ spec, cwd, timeoutMs });
      return Promise.resolve(typeof result === "function" ? result(spec) : result);
    },
  };
  return { runner, runs };
}

export interface GraphClientCall { method: string; args: unknown[] }

/**
 * A duck-typed GraphClient whose methods record their invocation and reject
 * with "not implemented" unless replaced through `overrides`.
 */
export function stubGraphClient(overrides: Record<string, unknown> = {}): { client: GraphClient; calls: GraphClientCall[] } {
  const calls: GraphClientCall[] = [];
  const target = new Proxy(overrides, {
    get(source, property: string): unknown {
      if (property in source) return source[property];
      return (...args: unknown[]): Promise<never> => {
        calls.push({ method: property, args });
        return Promise.reject(new Error(`stub GraphClient.${property} not implemented`));
      };
    },
  });
  return { client: target as GraphClient, calls };
}
