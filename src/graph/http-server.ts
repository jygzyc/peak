import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { initializeProjectLogsDirectory } from "../config/paths.js";
import {
  ApiError, requireDescription, requireFactDescription, requireIntentDescription, requireShortDescription,
} from "./api.js";
import { toTimeline } from "./export.js";
import { ProjectStoreRegistry } from "./project-store-registry.js";
import type { ArtifactRef, CompleteInput, ConcludeInput, CreateIntentInput, FactRef } from "./types.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
  token?: string;
  maxArtifactBytes?: number;
}

export type HttpRootHandler = (response: ServerResponse) => boolean;

export class GraphHttpServer {
  private server?: ReturnType<typeof createServer>;
  private host = "127.0.0.1";
  private assignedPort = 0;
  private token?: string;
  private maxArtifactBytes = 100 * 1024 * 1024;

  constructor(
    readonly registry: ProjectStoreRegistry,
    private readonly rootHandler?: HttpRootHandler,
  ) {}

  get baseUrl(): string {
    if (!this.server) throw new Error("server is not running");
    return `http://${this.host}:${this.assignedPort}`;
  }

  async start(options: HttpServerOptions = {}): Promise<void> {
    if (this.server) throw new Error("server already started");
    this.host = options.host ?? "127.0.0.1";
    if (!isLoopback(this.host) && !options.token) throw new Error("token required for non-loopback host");
    this.token = options.token;
    this.maxArtifactBytes = options.maxArtifactBytes ?? this.maxArtifactBytes;
    this.registry.gcArtifacts();
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port ?? 0, this.host);
      });
      const address = server.address();
      this.assignedPort = typeof address === "object" && address ? address.port : options.port ?? 0;
    } catch (error) {
      this.server = undefined;
      if (server.listening) server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.assignedPort = 0;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const method = request.method ?? "GET";
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts.length === 0 && method === "GET") {
        if (this.rootHandler?.(response)) return;
        throw new ApiError(404, "not found");
      }
      if (!this.authorized(request)) throw new ApiError(401, "unauthorized");
      if (parts[0] !== "api") throw new ApiError(404, "not found");

      if (parts.length === 2 && parts[1] === "projects") {
        if (method === "GET") return json(response, this.registry.list());
        if (method === "POST") {
          const body = await bodyObject(request);
          exact(body, ["title", "target", "goal", "scope"], ["scope"]);
          const project = this.registry.create({
            title: requireShortDescription(body.title, "title"),
            target: requireDescription(body.target, "target"),
            goal: requireDescription(body.goal, "goal"),
            scope: optionalString(body.scope),
          });
          operation(this.registry.get(project.id).dir, "project_created", { projectId: project.id });
          return json(response, project, 201);
        }
      }

      if (parts[1] === "fact-refs" && parts[2] === "resolve" && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["targetProjectId", "refs"]);
        const targetProjectId = requireString(body.targetProjectId, "targetProjectId");
        const refs = factRefs(body.refs);
        this.registry.validateRefs(targetProjectId, refs);
        return json(response, refs.map((ref) => ({ ref, fact: this.registry.get(ref.projectId).graph.fact(ref.factId) })));
      }

      if (parts[1] === "scopes" && parts[3] === "export" && method === "GET") {
        const graphs = this.registry.list().filter((project) => project.scope === parts[2])
          .map((project) => this.registry.get(project.id).graph.graph());
        return exported(response, graphs, url.searchParams.get("format"));
      }

      if (parts[1] !== "projects" || !parts[2]) throw new ApiError(404, "not found");
      const projectId = parts[2];
      const stores = this.registry.get(projectId);

      if (parts.length === 3) {
        if (method === "GET") return json(response, stores.graph.graph());
        if (method === "DELETE") { this.registry.remove(projectId); return empty(response, 204); }
      }
      if (parts[3] === "title" && method === "PUT") {
        const body = await bodyObject(request);
        exact(body, ["title"]);
        const project = stores.graph.setTitle(requireShortDescription(body.title, "title"));
        operation(stores.dir, "project_title_changed", { projectId });
        return json(response, project);
      }
      if (parts[3] === "status" && method === "PUT") {
        const body = await bodyObject(request);
        exact(body, ["status"]);
        if (body.status !== "active" && body.status !== "stopped") throw new ApiError(400, "invalid status");
        const project = stores.graph.setStatus(body.status);
        operation(stores.dir, "project_status_changed", { projectId, status: body.status });
        return json(response, project);
      }
      if (parts[3] === "export" && method === "GET") {
        return exported(response, stores.graph.graph(), url.searchParams.get("format"));
      }
      if (parts[3] === "facts" && parts[4] && method === "GET") {
        const fact = stores.graph.fact(parts[4]);
        if (!fact) throw new ApiError(404, "fact not found");
        return json(response, fact);
      }
      if (parts[3] === "artifacts" && parts.length === 4 && method === "POST") {
        const stored = await stores.artifacts.save(request, request.headers["content-type"] ?? "application/octet-stream", this.maxArtifactBytes);
        const ref = stores.graph.registerArtifact(stored);
        operation(stores.dir, "artifact_uploaded", { projectId, sha256: ref.sha256, sizeBytes: ref.sizeBytes });
        return json(response, ref, 201);
      }
      if (parts[3] === "artifacts" && parts[4] && (method === "GET" || method === "HEAD")) {
        const ref = stores.graph.artifact(parts[4]);
        if (!ref) throw new ApiError(404, "artifact not found");
        response.writeHead(200, { "content-type": ref.mediaType, "content-length": ref.sizeBytes, etag: ref.sha256 });
        if (method === "HEAD") { response.end(); return; }
        createReadStream(stores.artifacts.path(ref.sha256)).pipe(response);
        return;
      }
      if (parts[3] === "hints" && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["content", "creator"]);
        const hint = stores.graph.addHint({
          content: requireShortDescription(body.content, "content"), creator: requireShortDescription(body.creator, "creator"),
        });
        operation(stores.dir, "hint_added", { projectId, hintId: hint.id, creator: hint.creator });
        return json(response, hint, 201);
      }
      if (parts[3] === "intents" && parts.length === 4 && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["from", "description", "createdBy"]);
        const input: CreateIntentInput = {
          from: factRefs(body.from), description: requireIntentDescription(body.description),
          createdBy: requireShortDescription(body.createdBy, "createdBy"),
        };
        this.registry.validateRefs(projectId, input.from);
        const intent = stores.graph.createIntent(input);
        operation(stores.dir, "intent_created", { projectId, intentId: intent.id, createdBy: intent.createdBy });
        return json(response, intent, 201);
      }
      if (parts[3] === "intents" && parts[4] && parts[5] === "conclude" && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["description", "artifact", "concludedBy"], ["artifact"]);
        const requested = artifactRef(body.artifact);
        const canonical = requested ? stores.graph.artifact(requested.sha256) : undefined;
        if (requested && (!canonical || JSON.stringify(canonical) !== JSON.stringify(requested))) throw new ApiError(400, "invalid artifact reference");
        const input: ConcludeInput = {
          description: requireFactDescription(body.description), artifact: canonical ?? null,
          concludedBy: requireShortDescription(body.concludedBy, "concludedBy"),
        };
        const result = stores.graph.conclude(parts[4], input);
        operation(stores.dir, "intent_concluded", { projectId, intentId: parts[4], factId: result.fact.id, concludedBy: input.concludedBy });
        return json(response, result);
      }
      if (parts[3] === "complete" && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["from", "description", "completedBy"]);
        const input: CompleteInput = {
          from: factRefs(body.from), description: requireIntentDescription(body.description),
          completedBy: requireShortDescription(body.completedBy, "completedBy"),
        };
        this.registry.validateRefs(projectId, input.from);
        const completion = stores.graph.complete(input);
        operation(stores.dir, "project_completed", { projectId, intentId: completion.id, completedBy: input.completedBy });
        return json(response, completion);
      }
      if (parts[3] === "reopen" && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["description", "creator"]);
        const graph = stores.graph.reopen({
          description: requireFactDescription(body.description), creator: requireShortDescription(body.creator, "creator"),
        });
        operation(stores.dir, "project_reopened", { projectId, creator: body.creator });
        return json(response, graph);
      }
      throw new ApiError(404, "not found");
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      json(response, { error: error instanceof Error ? error.message : String(error) }, status);
    }
  }

  private authorized(request: IncomingMessage): boolean {
    if (!this.token) return true;
    return request.headers.authorization === `Bearer ${this.token}`;
  }
}

async function bodyObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new ApiError(413, "request body too large");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ApiError(400, "invalid JSON body"); }
}

function factRefs(value: unknown): FactRef[] {
  if (!Array.isArray(value)) throw new ApiError(400, "FactRef array required");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError(400, "invalid FactRef");
    const ref = item as Record<string, unknown>;
    exact(ref, ["projectId", "factId", "description"]);
    return {
      projectId: requireString(ref.projectId, "projectId"),
      factId: requireString(ref.factId, "factId"),
      description: requireDescription(ref.description, "description"),
    };
  });
}

function artifactRef(value: unknown): ArtifactRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid artifact");
  const ref = value as Record<string, unknown>;
  exact(ref, ["path", "sha256", "mediaType", "sizeBytes"]);
  if (!Number.isInteger(ref.sizeBytes) || (ref.sizeBytes as number) < 0) throw new ApiError(400, "invalid artifact size");
  return {
    path: requireString(ref.path, "artifact.path"), sha256: requireString(ref.sha256, "artifact.sha256"),
    mediaType: requireString(ref.mediaType, "artifact.mediaType"), sizeBytes: ref.sizeBytes as number,
  };
}
function exact(value: Record<string, unknown>, allowed: string[], optional: string[] = []): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  const missing = allowed.find((key) => !optional.includes(key) && !(key in value));
  if (unknown || missing) throw new ApiError(400, unknown ? `unknown field: ${unknown}` : `missing field: ${missing}`);
}
function requireString(value: unknown, label: string): string { return requireDescription(value, label); }
function optionalString(value: unknown): string | undefined { return value === undefined ? undefined : requireString(value, "string"); }
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
function exported(response: ServerResponse, value: Parameters<typeof toTimeline>[0], format: string | null): void {
  if (format !== null && format !== "json" && format !== "timeline") throw new ApiError(400, "invalid export format");
  json(response, format === "timeline" ? toTimeline(value) : value);
}
function empty(response: ServerResponse, status: number): void { response.writeHead(status); response.end(); }
function isLoopback(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1"; }
function operation(projectDir: string, type: string, data: Record<string, unknown>): void {
  const logs = initializeProjectLogsDirectory(projectDir);
  appendFileSync(join(logs, "main.log"), `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
}
