import { createReadStream, createWriteStream, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  AddHintInput, ArtifactRef, CompleteInput, ConcludeInput, CreateIntentInput, CreateProjectInput,
  Fact, FactRef, Hint, Intent, PathAbstract, ProjectGraph, ProjectMeta, ProjectStatus, ReopenInput, ResolvedFactSource,
} from "./types.js";

export interface GraphClientOptions {
  /**
   * Local Projects root used to materialize the Server's projects-root-relative
   * Artifact `inputPath` values (`<uuid>/artifacts/<sha256>`) into absolute
   * paths. Required whenever resolved sources carry relative paths.
   */
  projectsRoot?: string;
}

/** Registration payload accepted by the Server's Project ownership registry. */
export interface ProjectRegistrationInput {
  taskName: string;
  boardDir: string;
  mode: "start" | "resume";
  runtimeId: string;
  pid?: number | null;
  container?: string | null;
  graphUrl?: string | null;
  webUrl?: string | null;
}

export class GraphClient {
  constructor(readonly baseUrl: string, private readonly options: GraphClientOptions = {}) {}

  listProjects(): Promise<ProjectMeta[]> { return this.request("GET", "/api/projects"); }
  createProject(input: CreateProjectInput): Promise<ProjectMeta> { return this.request("POST", "/api/projects", input); }
  getProject(id: string): Promise<ProjectGraph> { return this.request("GET", `/api/projects/${id}`); }
  deleteProject(id: string): Promise<void> { return this.request("DELETE", `/api/projects/${id}`); }
  setStatus(id: string, status: Exclude<ProjectStatus, "completed">): Promise<ProjectMeta> {
    return this.request("PUT", `/api/projects/${id}/status`, { status });
  }
  getFact(ref: FactRef): Promise<Fact> { return this.request("GET", `/api/projects/${ref.projectId}/facts/${ref.id}`); }
  getPathAbstract(id: string, factId: string): Promise<PathAbstract> {
    return this.request("GET", `/api/projects/${id}/path-abstracts/${factId}`);
  }
  putPathAbstract(id: string, factId: string, value: PathAbstract): Promise<PathAbstract> {
    return this.request("POST", `/api/projects/${id}/path-abstracts/${factId}`, value);
  }
  async resolveFactRefs(targetProjectId: string, refs: FactRef[]): Promise<ResolvedFactSource[]> {
    const sources = await this.request<ResolvedFactSource[]>("POST", "/api/fact-refs/resolve", { targetProjectId, refs });
    // The Server returns projects-root-relative POSIX inputPaths so a remote
    // or container Runtime can re-anchor them under its own Projects root.
    for (const source of sources) {
      const artifact = source.fact.artifact;
      if (!artifact || isAbsolute(artifact.inputPath)) continue;
      if (!this.options.projectsRoot) throw new Error("GraphClient requires projectsRoot to resolve relative Artifact paths");
      artifact.inputPath = join(this.options.projectsRoot, ...artifact.inputPath.split("/"));
    }
    return sources;
  }
  addHint(id: string, input: AddHintInput): Promise<Hint> { return this.request("POST", `/api/projects/${id}/hints`, input); }
  createIntent(id: string, input: CreateIntentInput): Promise<Intent> { return this.request("POST", `/api/projects/${id}/intents`, input); }
  conclude(id: string, intentId: string, input: ConcludeInput): Promise<{ intent: Intent; fact: Fact }> {
    return this.request("POST", `/api/projects/${id}/intents/${intentId}/conclude`, input);
  }
  complete(id: string, input: CompleteInput): Promise<Intent> { return this.request("POST", `/api/projects/${id}/complete`, input); }
  reopen(id: string, input: ReopenInput): Promise<ProjectGraph> { return this.request("POST", `/api/projects/${id}/reopen`, input); }

  /** Server-authoritative Project ownership registration (409 on conflict); used by external/container task launchers. */
  async registerProject(id: string, input: ProjectRegistrationInput): Promise<void> {
    await this.request("POST", `/api/projects/${id}/registration`, input);
  }

  /** Best-effort deregistration; a missing record is not an error. */
  async deregisterProject(id: string, runtimeId: string): Promise<void> {
    try {
      await this.request("DELETE", `/api/projects/${id}/registration`, { runtimeId });
    } catch (error) {
      if (!(error instanceof GraphClientError) || error.status !== 404) throw error;
    }
  }

  async uploadArtifact(id: string, path: string, mediaType: string): Promise<ArtifactRef> {
    const response = await fetch(this.url(`/api/projects/${id}/artifacts`), {
      method: "POST", headers: { "content-type": mediaType }, body: Readable.toWeb(createReadStream(path)), duplex: "half",
    } as RequestInit & { duplex: "half" });
    return this.response<ArtifactRef>(response);
  }

  /** Uploads inline content; the optional filename is a content-based output name, never a graph node id. */
  async uploadContent(id: string, content: string, mediaType: string, filename?: string): Promise<ArtifactRef> {
    const response = await fetch(this.url(`/api/projects/${id}/artifacts`), {
      method: "POST",
      headers: {
        "content-type": mediaType,
        ...(filename ? { "x-artifact-filename": filename } : {}),
      },
      body: content,
    });
    return this.response<ArtifactRef>(response);
  }

  async artifactContent(id: string, sha256: string): Promise<string> {
    const response = await fetch(this.url(`/api/projects/${id}/artifacts/${sha256}`));
    if (!response.ok) throw new GraphClientError(response.status, await response.text());
    return response.text();
  }

  async exportProject(id: string, format: "json" | "timeline" = "json"): Promise<string> {
    return this.text("GET", `/api/projects/${id}/export?format=${format}`);
  }

  async downloadProjectArchive(id: string, destination: string): Promise<void> {
    const response = await fetch(this.url(`/api/projects/${id}/export?format=archive`));
    if (!response.ok) throw new GraphClientError(response.status, await response.text());
    if (!response.body) throw new Error("Project archive response has no body");
    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        createWriteStream(destination, { flags: "wx" }),
      );
    } catch (error) {
      rmSync(destination, { force: true });
      throw error;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.url(path), {
      method, headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return undefined as T;
    return this.response<T>(response);
  }

  private async text(method: string, path: string): Promise<string> {
    const response = await fetch(this.url(path), { method });
    if (!response.ok) throw new GraphClientError(response.status, await response.text());
    return response.text();
  }

  private async response<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* use raw body */ }
      throw new GraphClientError(response.status, message);
    }
    return JSON.parse(text) as T;
  }

  private url(path: string): string { return `${this.baseUrl.replace(/\/$/, "")}${path}`; }
}

export class GraphClientError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
