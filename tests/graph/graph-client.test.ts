import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { GraphClient, GraphClientError } from "../../dist/graph/graph-client.js";
import type { CreateProjectInput } from "../../dist/graph/types.js";
import { jsonResponse, stubFetch } from "../helpers/fakes.ts";

const BASE = "http://peak.test";

test("JSON endpoints set method, URL, content-type, and serialized body", async (t) => {
  const calls = stubFetch(t, () => jsonResponse(201, { id: "p1" }));
  const client = new GraphClient(`${BASE}/`); // a trailing slash is tolerated
  const input = { title: "Source", target: "Source", goal: "done" } as CreateProjectInput;
  await client.createProject(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, `${BASE}/api/projects`);
  assert.equal(calls[0]!.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.body as string), input);
});

test("GET endpoints send no body and no content-type header", async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, []));
  const client = new GraphClient(BASE);
  assert.deepEqual(await client.listProjects(), []);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, `${BASE}/api/projects`);
  assert.equal(calls[0]!.headers["content-type"], undefined);
  assert.equal(calls[0]!.body, undefined);
});

test("non-ok responses raise GraphClientError with the server's error message", async (t) => {
  stubFetch(t, () => jsonResponse(409, { error: "already actively leased" }));
  const client = new GraphClient(BASE);
  await assert.rejects(
    client.getProject("p1"),
    (error: unknown) => error instanceof GraphClientError && error.status === 409 && error.message === "already actively leased",
  );
});

test("a non-JSON error body becomes the raw error message", async (t) => {
  stubFetch(t, () => new Response("boom", { status: 500 }));
  const client = new GraphClient(BASE);
  await assert.rejects(client.getProject("p1"), (error: unknown) => {
    return error instanceof GraphClientError && error.status === 500 && error.message === "boom";
  });
});

test("204 responses resolve to undefined", async (t) => {
  const calls = stubFetch(t, () => new Response(null, { status: 204 }));
  const client = new GraphClient(BASE);
  assert.equal(await client.deleteProject("p1"), undefined);
  assert.equal(calls[0]!.method, "DELETE");
  assert.equal(calls[0]!.url, `${BASE}/api/projects/p1`);
});

test("uploadContent posts inline content and the optional filename header", async (t) => {
  const calls = stubFetch(t, () => jsonResponse(201, { sha256: "abc", mediaType: "text/plain" }));
  const client = new GraphClient(BASE);
  const ref = await client.uploadContent("p1", "hello", "text/plain", "note.txt");
  assert.equal(ref.sha256, "abc");
  assert.equal(calls[0]!.url, `${BASE}/api/projects/p1/artifacts`);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.headers["content-type"], "text/plain");
  assert.equal(calls[0]!.headers["x-artifact-filename"], "note.txt");
  assert.equal(calls[0]!.body, "hello");

  await client.uploadContent("p1", "hello", "text/plain");
  assert.equal(calls[1]!.headers["x-artifact-filename"], undefined, "no filename header when omitted");
});

test("artifactContent rejects non-ok responses with GraphClientError", async (t) => {
  stubFetch(t, () => new Response("missing", { status: 404 }));
  const client = new GraphClient(BASE);
  await assert.rejects(client.artifactContent("p1", "sha"), (error: unknown) => {
    return error instanceof GraphClientError && error.status === 404 && error.message === "missing";
  });
});

test("resolveFactRefs re-anchors relative artifact paths under the projects root", async (t) => {
  stubFetch(t, () => jsonResponse(200, [{
    source: { projectId: "p1", id: "f1" },
    fact: { id: "f1", artifact: { sha256: "s", inputPath: "uuid-1/artifacts/s" } },
  }]));
  const projectsRoot = join("peak-home", "projects");
  const client = new GraphClient(BASE, { projectsRoot });
  const [source] = await client.resolveFactRefs("p2", [{ projectId: "p1", id: "f1" }]);
  assert.equal(source!.fact.artifact!.inputPath, join(projectsRoot, "uuid-1", "artifacts", "s"));
});

test("resolveFactRefs requires projectsRoot for relative artifact paths", async (t) => {
  stubFetch(t, () => jsonResponse(200, [{
    source: { projectId: "p1", id: "f1" },
    fact: { id: "f1", artifact: { sha256: "s", inputPath: "uuid-1/artifacts/s" } },
  }]));
  const client = new GraphClient(BASE);
  await assert.rejects(
    client.resolveFactRefs("p2", [{ projectId: "p1", id: "f1" }]),
    /requires projectsRoot/,
  );
});
