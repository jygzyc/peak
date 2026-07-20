/**
 * HTTP API and dashboard server for peak sessions.
 *
 * Exposes project lists, project details, directives, events, and the
 * embedded dashboard HTML. The server is an adapter over Graph state and should
 * not duplicate loopestration policy.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Graph } from "../graph/graph.js";
import type { DirectiveInput, Project, ProjectId, Verdict } from "../agent/types.js";
import { ServerSessionGraphReader } from "./session-graph-reader.js";
import type { FederationBus, TaskGroupState } from "../graph/federation-bus.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function loadDashboard(): string {
  const candidates = [
    join(MODULE_DIR, "dashboard.html"),
    join(MODULE_DIR, "server", "dashboard.html"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  throw new Error(`dashboard.html not found in: ${candidates.join(", ")}`);
}

export interface HttpServerOptions {
  host?: string;
  port?: number;
  /** Required when binding beyond loopback; protects control endpoints everywhere. */
  token?: string;
}

export interface HttpSessionBinding {
  sessionId: string;
  graph: Graph;
  projectId: ProjectId;
  taskGroupScope?: string;
}

export class HttpServer {
  private server: ReturnType<typeof createServer> | undefined;
  private assignedPort = 0;
  private assignedHost = "127.0.0.1";
  private readonly sessions = new Map<string, HttpSessionBinding>();
  private controlToken?: string;

  constructor(private readonly federationBus?: FederationBus) {}

  registerSession(binding: HttpSessionBinding): void {
    if (this.sessions.has(binding.sessionId)) {
      throw new Error(`HTTP session already registered: ${binding.sessionId}`);
    }
    const project = binding.graph.getProject(binding.projectId);
    if (!project || project.sessionId !== binding.sessionId) {
      throw new Error(`HTTP session project not found: ${binding.sessionId}`);
    }
    this.sessions.set(binding.sessionId, binding);
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  listSessions(): HttpSessionBinding[] {
    return this.sessionBindings();
  }

  get port(): number { return this.assignedPort; }
  get baseUrl(): string {
    if (!this.server || this.assignedPort === 0) throw new Error("HTTP server is not started");
    const host = this.assignedHost === "::1" ? "[::1]" : this.assignedHost;
    return `http://${host}:${this.assignedPort}`;
  }

  start(options: HttpServerOptions = {}): Promise<void> {
    if (this.server) return Promise.reject(new Error("HTTP server is already started"));
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 25429;
    if (!isLoopbackHost(host) && !options.token) {
      return Promise.reject(new Error("HTTP server requires a token when binding beyond loopback"));
    }
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      const fail = (error: Error): void => {
        if (this.server === server) this.server = undefined;
        this.assignedPort = 0;
        reject(error);
      };
      server.once("error", fail);
      this.server = server;
      try {
        server.listen(port, host, () => {
          server.off("error", fail);
          const addr = server.address();
          this.controlToken = options.token;
          this.assignedHost = host;
          this.assignedPort = typeof addr === "object" && addr ? addr.port : port;
          resolve();
        });
      } catch (error) {
        server.off("error", fail);
        this.server = undefined;
        this.assignedPort = 0;
        reject(error);
      }
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (this.server === server) this.server = undefined;
        this.assignedPort = 0;
        this.controlToken = undefined;
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (path === "/" && method === "GET") {
        return this.serveDashboard(res);
      }

      if (path === "/api/sessions" && method === "POST") {
        return this.json(res, this.sessionBindings().map((binding) => this.sessionSummary(binding)));
      }

      if (path === "/api/task-groups" && method === "POST") {
        return this.json(res, this.federationBus?.taskGroups() ?? []);
      }

      const taskGroupMatch = path.match(/^\/api\/task-groups\/([^/]+)$/);
      if (taskGroupMatch && method === "POST") {
        const group = this.federationBus?.taskGroup(decodeURIComponent(taskGroupMatch[1]));
        return group
          ? this.json(res, group)
          : this.json(res, { error: "task group not found" }, 404);
      }

      const snapshotMatch = path.match(/^\/api\/sessions\/([^/]+)\/graph\/snapshot$/);
      if (snapshotMatch && method === "POST") {
        const binding = this.sessionBinding(decodeURIComponent(snapshotMatch[1]));
        const project = binding && this.bindingProject(binding);
        if (!binding || !project) return this.json(res, { error: "session not found" }, 404);
        const body = parseJsonObject(await this.readBody(req));
        const profileId = stringOrUndefined(body.profileId);
        if (!profileId) return this.json(res, { error: "profileId is required" }, 400);
        const profile = project.taskConfig.profiles[profileId];
        if (!profile) return this.json(res, { error: `profile not found: ${profileId}` }, 404);
        const profileContext = profile.context;
        if (body.projectId !== undefined && body.projectId !== project.id) {
          return this.json(res, { error: "project does not belong to session" }, 409);
        }
        const hints = binding.graph.unconsumedHints(project.id);
        const hintIds = Array.isArray(body.hintIds)
          ? new Set(body.hintIds.filter((id): id is string => typeof id === "string"))
          : undefined;
        const intentId = stringOrUndefined(body.intentId);
        const candidateFactId = stringOrUndefined(body.candidateFactId);
        const reader = new ServerSessionGraphReader(binding.graph);
        const snapshot = await reader.readSnapshot({
          sessionId: binding.sessionId,
          projectId: project.id,
          profileId,
          spec: profileContext,
          hints: hintIds ? hints.filter((hint) => hintIds.has(hint.id)) : undefined,
          recentVerdicts: Array.isArray(body.recentVerdicts)
            ? body.recentVerdicts as Array<{ factId: string; verdict: Verdict; intentId?: string }>
            : undefined,
          intent: intentId ? binding.graph.getIntent(project.id, intentId) : undefined,
          candidate: candidateFactId ? binding.graph.getFact(project.id, candidateFactId) : undefined,
          throughSeq: numberOrUndefined(body.throughSeq),
          signal: AbortSignal.timeout(30_000),
        });
        return this.json(res, snapshot);
      }

      const sessionDirectiveMatch = path.match(/^\/api\/sessions\/([^/]+)\/directives$/);
      if (sessionDirectiveMatch && method === "POST") {
        if (!this.authorizeControl(req, res)) return;
        const binding = this.sessionBinding(decodeURIComponent(sessionDirectiveMatch[1]));
        const project = binding && this.bindingProject(binding);
        if (!binding || !project) return this.json(res, { error: "session not found" }, 404);
        const input = JSON.parse(await this.readBody(req)) as DirectiveInput;
        const directive = binding.graph.addDirective(project.id, input);
        return this.json(res, directive);
      }

      const sessionCollectionMatch = path.match(/^\/api\/sessions\/([^/]+)\/(facts|intents|end-facts|events)$/);
      if (sessionCollectionMatch && method === "POST") {
        const binding = this.sessionBinding(decodeURIComponent(sessionCollectionMatch[1]));
        const project = binding && this.bindingProject(binding);
        if (!binding || !project) return this.json(res, { error: "session not found" }, 404);
        const body = parseJsonObject(await this.readBody(req));
        switch (sessionCollectionMatch[2]) {
          case "facts": return this.json(res, binding.graph.facts(project.id));
          case "intents": return this.json(res, binding.graph.intents(project.id));
          case "end-facts": return this.json(res, binding.graph.endFacts(project.id));
          case "events": return this.json(res, binding.graph.events(
            project.id,
            numberOrUndefined(body.since),
            500,
          ));
        }
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && method === "POST") {
        const binding = this.sessionBinding(decodeURIComponent(sessionMatch[1]));
        const project = binding && this.bindingProject(binding);
        if (!binding || !project) return this.json(res, { error: "session not found" }, 404);
        return this.json(res, {
          ...this.projectDetail(binding.graph, project),
          session: this.sessionSummary(binding),
        });
      }

      if (path.startsWith("/api/") && method !== "POST") {
        return this.json(res, { error: "API endpoints require POST" }, 405);
      }
      this.json(res, { error: "not found", path }, 404);
    } catch (err) {
      const status = err instanceof HttpRequestError
        ? err.status
        : err instanceof SyntaxError ? 400 : 500;
      this.json(res, { error: err instanceof Error ? err.message : String(err) }, status);
    }
  }

  private serveDashboard(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    res.end(loadDashboard());
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let exceeded = false;
      req.on("data", (c: Buffer) => {
        if (exceeded) return;
        bytes += c.byteLength;
        if (bytes > maxBytes) {
          exceeded = true;
          reject(new HttpRequestError(413, `request body exceeds ${maxBytes} bytes`));
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (!exceeded) resolve(Buffer.concat(chunks).toString("utf-8"));
      });
      req.on("error", reject);
    });
  }

  private sessionBindings(): HttpSessionBinding[] {
    return [...this.sessions.values()];
  }

  private sessionBinding(sessionId: string): HttpSessionBinding | undefined {
    return this.sessionBindings().find((binding) => binding.sessionId === sessionId);
  }

  private bindingProject(binding: HttpSessionBinding): Project | undefined {
    if (binding.projectId) return binding.graph.getProject(binding.projectId);
    return binding.graph.listProjects().find((project) => project.sessionId === binding.sessionId);
  }

  private projectDetail(graph: Graph, project: Project) {
    return {
      project,
      facts: graph.facts(project.id),
      intents: graph.intents(project.id),
      endFacts: graph.endFacts(project.id),
      hints: graph.unconsumedHints(project.id),
      directives: graph.unconsumedDirectives(project.id),
      progress: graph.progress(project.id),
    };
  }

  private sessionSummary(binding: HttpSessionBinding): Record<string, unknown> {
    const project = this.bindingProject(binding);
    const group = this.bindingTaskGroup(binding);
    const member = group?.members.find((candidate) => candidate.sessionId === binding.sessionId);
    return {
      sessionId: binding.sessionId,
      projectId: project?.id,
      name: project?.name,
      status: project?.status,
      taskGroup: group && member ? {
        scope: group.scope,
        status: group.status,
        pendingBroadcasts: group.pendingBroadcasts,
        memberStatus: member.status,
      } : undefined,
    };
  }

  private bindingTaskGroup(binding: HttpSessionBinding): TaskGroupState | undefined {
    if (!this.federationBus) return undefined;
    if (binding.taskGroupScope) return this.federationBus.taskGroup(binding.taskGroupScope);
    return this.federationBus.taskGroups().find((group) => (
      group.members.some((member) => member.sessionId === binding.sessionId)
    ));
  }

  private authorizeControl(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.controlToken) {
      if (isLoopbackAddress(req.socket.remoteAddress)) return true;
      this.json(res, { error: "control endpoint is loopback-only" }, 403);
      return false;
    }
    const authorization = req.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const header = req.headers["x-peak-token"];
    const supplied = bearer ?? (Array.isArray(header) ? header[0] : header);
    if (supplied && equalSecret(supplied, this.controlToken)) return true;
    res.setHeader("www-authenticate", "Bearer");
    this.json(res, { error: "control token required" }, 401);
    return false;
  }
}

class HttpRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}
