import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { bodyObject, empty, exact, json, writeProjectLog } from "../utils/helpers.js";
import {
  ApiError, hasUnsafeFilenameSegments, requireCustomProfileDigest, requireDescription, requireFactDescription, requireIntentDescription, requireShortDescription, toTimeline,
} from "./api.js";
import { ProjectStoreRegistry } from "./project-store-registry.js";
import { parsePathAbstract, readPathAbstract, writePathAbstract } from "./path-abstract.js";
import { type ArtifactRef, type CompleteInput, type ConcludeInput, type CreateIntentInput, type FactRef } from "./types.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
  maxArtifactBytes?: number;
}

export type HttpRootHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

/**
 * Generic `/api/*` extension. An extension receives a matching request and may
 * handle it. Returning `true`
 * stops further extension probing. graph/ depends only on this type and never
 * on the implementing module, so Runtime/CLI compose API surface at the
 * composition root without coupling Graph state to Runtime state.
 */
export interface ApiExtension {
  matches(method: string, parts: string[]): boolean;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export class GraphHttpServer {
  private server?: ReturnType<typeof createServer>;
  private host = "127.0.0.1";
  private assignedPort = 0;
  private maxArtifactBytes = 10 * 1024 * 1024;

  constructor(
    readonly registry: ProjectStoreRegistry,
    private readonly rootHandler?: HttpRootHandler,
    private readonly apiExtensions: ApiExtension[] = [],
  ) {}

  get baseUrl(): string {
    if (!this.server) throw new Error("server is not running");
    return `http://${this.host}:${this.assignedPort}`;
  }

  async start(options: HttpServerOptions = {}): Promise<void> {
    if (this.server) throw new Error("server already started");
    this.host = options.host ?? "127.0.0.1";
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
      if (method === "GET" && parts[0] !== "api" && this.rootHandler?.(request, response)) return;
      if (parts.length === 0) throw new ApiError(404, "not found");
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
            scope: body.scope === undefined ? undefined : requireDescription(body.scope, "scope"),
          });
          writeProjectLog(this.registry.get(project.id).dir, "project_created", { projectId: project.id });
          return json(response, project, 201);
        }
      }

      if (parts[1] === "fact-refs" && parts[2] === "resolve" && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["targetProjectId", "refs"]);
        const targetProjectId = requireDescription(body.targetProjectId, "targetProjectId");
        const refs = factRefs(body.refs);
        this.registry.validateRefs(targetProjectId, refs);
        return json(response, refs.map((ref) => {
          const source = this.registry.get(ref.projectId);
          const fact = source.graph.fact(ref.id)!;
          return {
            ref,
            fact: {
              id: fact.id, description: fact.description, createdAt: fact.createdAt,
              artifact: fact.artifact ? {
                sha256: fact.artifact.sha256, mediaType: fact.artifact.mediaType, sizeBytes: fact.artifact.sizeBytes,
                filename: fact.artifact.filename,
                // Projects-root-relative POSIX path; the client re-anchors it
                // under its own Projects root (per-Project minimal visibility).
                inputPath: `${ref.projectId}/artifacts/${fact.artifact.sha256}`, readOnly: true,
              } : null,
            },
          };
        }));
      }

      // Extension probe: lets Runtime/CLI inject additional
      // read-only /api/* routes (e.g. /api/runtime/*) without graph/ depending
      // on runtime/. Probed before the project-scoped guard so non-projects
      // paths are routable; each extension owns its own path matching.
      for (const ext of this.apiExtensions) {
        if (ext.matches(method, parts) && await ext.handle(request, response)) return;
      }

      if (parts[1] !== "projects" || !parts[2]) throw new ApiError(404, "not found");
      const projectId = parts[2];
      const stores = this.registry.get(projectId);

      if (parts.length === 3) {
        if (method === "GET") return json(response, stores.graph.graph());
        if (method === "DELETE") { this.registry.remove(projectId); return empty(response, 204); }
      }
      if (parts[3] === "status" && method === "PUT") {
        const body = await bodyObject(request);
        exact(body, ["status"]);
        if (body.status !== "active" && body.status !== "stopped") throw new ApiError(400, "invalid status");
        const project = stores.graph.setStatus(body.status);
        writeProjectLog(stores.dir, "project_status_changed", { projectId, status: body.status });
        return json(response, project);
      }
      if (parts[3] === "export" && method === "GET") {
        const format = url.searchParams.get("format");
        if (format === "archive") return await projectArchive(response, this.registry, projectId);
        return exported(response, stores.graph.graph(), format);
      }
      if (parts[3] === "facts" && parts[4] && method === "GET") {
        const fact = stores.graph.fact(parts[4]);
        if (!fact) throw new ApiError(404, "fact not found");
        return json(response, fact);
      }
      if (parts[3] === "path-abstracts" && parts[4] && parts.length === 5) {
        const fact = stores.graph.fact(parts[4]);
        if (!fact || fact.id === "origin" || fact.id === "goal") throw new ApiError(404, "Fact not found");
        if (method === "GET") {
          const abstract = readPathAbstract(stores.dir, fact.id);
          if (!abstract) throw new ApiError(404, "PathAbstract not found");
          return json(response, abstract);
        }
        if (method === "POST") {
          const abstract = parsePathAbstract(await bodyObject(request));
          if (abstract.factRef.projectId !== projectId || abstract.factRef.description !== fact.description) {
            throw new ApiError(400, "PathAbstract FactRef mismatch");
          }
          const stored = writePathAbstract(stores.dir, fact.id, abstract);
          writeProjectLog(stores.dir, "path_abstract_written", { projectId, factId: fact.id });
          return json(response, stored, 201);
        }
      }
      if (parts[3] === "artifacts" && parts.length === 4 && method === "POST") {
        const filename = artifactFilename(request.headers["x-artifact-filename"]);
        const stored = await stores.artifacts.save(request, request.headers["content-type"] ?? "application/octet-stream", this.maxArtifactBytes, filename);
        const ref = stores.graph.registerArtifact(stored);
        writeProjectLog(stores.dir, "artifact_uploaded", { projectId, sha256: ref.sha256, sizeBytes: ref.sizeBytes, filename: ref.filename });
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
        writeProjectLog(stores.dir, "hint_added", { projectId, hintId: hint.id, creator: hint.creator });
        return json(response, hint, 201);
      }
      if (parts[3] === "intents" && parts.length === 4 && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["from", "customProfile", "customProfileDigest", "hintIds", "description", "createdBy"], ["customProfile", "customProfileDigest", "hintIds"]);
        const input: CreateIntentInput = {
          from: factRefs(body.from),
          customProfile: body.customProfile === undefined || body.customProfile === null ? null : requireShortDescription(body.customProfile, "customProfile"),
          customProfileDigest: body.customProfileDigest === undefined || body.customProfileDigest === null
            ? null : requireCustomProfileDigest(body.customProfileDigest),
          hintIds: shortStrings(body.hintIds, "hintIds"),
          description: requireIntentDescription(body.description),
          createdBy: requireShortDescription(body.createdBy, "createdBy"),
        };
        this.registry.validateLeafRefs(projectId, input.from);
        const intent = stores.graph.createIntent(input);
        writeProjectLog(stores.dir, "intent_created", { projectId, intentId: intent.id, customProfile: intent.customProfile, customProfileDigest: intent.customProfileDigest, hintIds: intent.hintIds, createdBy: intent.createdBy });
        return json(response, intent, 201);
      }
      if (parts[3] === "intents" && parts[4] && parts[5] === "conclude" && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["description", "artifact", "concludedBy"]);
        const requested = artifactRef(body.artifact);
        let canonical: ArtifactRef | null = null;
        if (requested) {
          const stored = stores.graph.artifact(requested.sha256);
          if (!stored || JSON.stringify(stored) !== JSON.stringify(requested)) throw new ApiError(400, "invalid artifact reference");
          canonical = stored;
        }
        const input: ConcludeInput = {
          description: requireFactDescription(body.description), artifact: canonical,
          concludedBy: requireShortDescription(body.concludedBy, "concludedBy"),
        };
        const result = stores.graph.conclude(parts[4], input);
        writeProjectLog(stores.dir, "intent_concluded", { projectId, intentId: parts[4], factId: result.fact.id, artifact: result.fact.artifact, concludedBy: input.concludedBy });
        return json(response, result);
      }
      if (parts[3] === "complete" && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["from", "hintIds", "description", "completedBy"], ["hintIds"]);
        const input: CompleteInput = {
          from: factRefs(body.from), hintIds: shortStrings(body.hintIds, "hintIds"),
          description: requireIntentDescription(body.description),
          completedBy: requireShortDescription(body.completedBy, "completedBy"),
        };
        this.registry.validateLeafRefs(projectId, input.from);
        const completion = stores.graph.complete(input);
        writeProjectLog(stores.dir, "project_completed", { projectId, intentId: completion.id, completedBy: input.completedBy });
        return json(response, completion);
      }
      if (parts[3] === "reopen" && method === "POST") {
        const body = await bodyObject(request);
        exact(body, ["description", "creator"]);
        const graph = this.registry.reopen(projectId, {
          description: requireFactDescription(body.description), creator: requireShortDescription(body.creator, "creator"),
        });
        writeProjectLog(stores.dir, "project_reopened", { projectId, creator: body.creator });
        return json(response, graph);
      }
      throw new ApiError(404, "not found");
    } catch (error) {
      if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
      const status = error instanceof ApiError ? error.status : 500;
      json(response, { error: error instanceof Error ? error.message : String(error) }, status);
    }
  }

}

function factRefs(value: unknown): FactRef[] {
  if (!Array.isArray(value)) throw new ApiError(400, "FactRef array required");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError(400, "invalid FactRef");
    const ref = item as Record<string, unknown>;
    exact(ref, ["projectId", "id", "description"]);
    return {
      projectId: requireDescription(ref.projectId, "projectId"),
      id: requireDescription(ref.id, "id"),
      description: requireDescription(ref.description, "description"),
    };
  });
}

function shortStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ApiError(400, `${label} must be an array`);
  const result = value.map((item) => requireShortDescription(item, label));
  if (new Set(result).size !== result.length) throw new ApiError(400, `${label} contains duplicates`);
  return result;
}

/** Validates the optional content-based output filename sent as x-artifact-filename. */
function artifactFilename(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const name = requireShortDescription(Array.isArray(value) ? value[0] : value, "x-artifact-filename");
  if (hasUnsafeFilenameSegments(name)) throw new ApiError(400, "invalid artifact filename");
  return name;
}

function artifactRef(value: unknown): ArtifactRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid artifact");
  const ref = value as Record<string, unknown>;
  exact(ref, ["path", "sha256", "mediaType", "sizeBytes", "filename"], ["filename"]);
  if (!Number.isInteger(ref.sizeBytes) || (ref.sizeBytes as number) < 0) throw new ApiError(400, "invalid artifact size");
  return {
    path: requireDescription(ref.path, "artifact.path"), sha256: requireDescription(ref.sha256, "artifact.sha256"),
    mediaType: requireDescription(ref.mediaType, "artifact.mediaType"), sizeBytes: ref.sizeBytes as number,
    filename: ref.filename === undefined || ref.filename === null ? null : requireShortDescription(ref.filename, "artifact.filename"),
  };
}
function exported(response: ServerResponse, value: Parameters<typeof toTimeline>[0], format: string | null): void {
  if (format !== null && format !== "json" && format !== "timeline") throw new ApiError(400, "invalid export format");
  json(response, format === "timeline" ? toTimeline(value) : value);
}

async function projectArchive(response: ServerResponse, registry: ProjectStoreRegistry, projectId: string): Promise<void> {
  const temporaryDir = mkdtempSync(join(registry.baseDir, ".download-"));
  const path = join(temporaryDir, `peak-${projectId}.tar.gz`);
  try {
    await registry.exportProjectArchive(projectId, path);
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": statSync(path).size,
      "content-disposition": `attachment; filename=\"peak-${projectId}.tar.gz\"`,
      "cache-control": "no-store",
    });
    await pipeline(createReadStream(path), response);
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}
