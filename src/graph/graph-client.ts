import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  AddHintInput, ArtifactRef, CompleteInput, ConcludeInput, CreateIntentInput, CreateProjectInput,
  Fact, FactRef, Hint, Intent, ProjectGraph, ProjectMeta, ProjectStatus, ReopenInput,
} from "./types.js";

export class GraphClient {
  constructor(readonly baseUrl: string, readonly token?: string) {}

  listProjects(): Promise<ProjectMeta[]> { return this.request("GET", "/api/projects"); }
  createProject(input: CreateProjectInput): Promise<ProjectMeta> { return this.request("POST", "/api/projects", input); }
  getProject(id: string): Promise<ProjectGraph> { return this.request("GET", `/api/projects/${id}`); }
  deleteProject(id: string): Promise<void> { return this.request("DELETE", `/api/projects/${id}`); }
  setTitle(id: string, title: string): Promise<ProjectMeta> { return this.request("PUT", `/api/projects/${id}/title`, { title }); }
  setStatus(id: string, status: Exclude<ProjectStatus, "completed">): Promise<ProjectMeta> {
    return this.request("PUT", `/api/projects/${id}/status`, { status });
  }
  getFact(ref: FactRef): Promise<Fact> { return this.request("GET", `/api/projects/${ref.projectId}/facts/${ref.factId}`); }
  resolveFactRefs(targetProjectId: string, refs: FactRef[]): Promise<Array<{ ref: FactRef; fact: Fact }>> {
    return this.request("POST", "/api/fact-refs/resolve", { targetProjectId, refs });
  }
  addHint(id: string, input: AddHintInput): Promise<Hint> { return this.request("POST", `/api/projects/${id}/hints`, input); }
  createIntent(id: string, input: CreateIntentInput): Promise<Intent> { return this.request("POST", `/api/projects/${id}/intents`, input); }
  conclude(id: string, intentId: string, input: ConcludeInput): Promise<{ intent: Intent; fact: Fact }> {
    return this.request("POST", `/api/projects/${id}/intents/${intentId}/conclude`, input);
  }
  complete(id: string, input: CompleteInput): Promise<Intent> { return this.request("POST", `/api/projects/${id}/complete`, input); }
  reopen(id: string, input: ReopenInput): Promise<ProjectGraph> { return this.request("POST", `/api/projects/${id}/reopen`, input); }

  async uploadArtifact(id: string, path: string, mediaType: string): Promise<ArtifactRef> {
    const response = await fetch(this.url(`/api/projects/${id}/artifacts`), {
      method: "POST", headers: this.headers({ "content-type": mediaType }), body: Readable.toWeb(createReadStream(path)), duplex: "half",
    } as RequestInit & { duplex: "half" });
    return this.response<ArtifactRef>(response);
  }

  async downloadArtifact(id: string, sha256: string, path: string): Promise<void> {
    const response = await fetch(this.url(`/api/projects/${id}/artifacts/${sha256}`), { headers: this.headers() });
    if (!response.ok || !response.body) throw new GraphClientError(response.status, await response.text());
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(path));
  }

  async exportProject(id: string, format: "json" | "timeline" = "json"): Promise<string> {
    return this.text("GET", `/api/projects/${id}/export?format=${format}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.url(path), {
      method, headers: this.headers(body === undefined ? undefined : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return undefined as T;
    return this.response<T>(response);
  }

  private async text(method: string, path: string): Promise<string> {
    const response = await fetch(this.url(path), { method, headers: this.headers() });
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

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...extra, authorization: `Bearer ${this.token}` } : extra;
  }
  private url(path: string): string { return `${this.baseUrl.replace(/\/$/, "")}${path}`; }
}

export class GraphClientError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
