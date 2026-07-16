import { test } from "node:test";
import { strict as assert } from "node:assert";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { env } from "./helper.ts";
import {
  attachScenario,
  createScenarioProject,
  decisions,
  loadMockScenario,
  tickUntilCompleted,
} from "./scenario-helper.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASE = join(ROOT, "examples", "requirement-implementation");
const TASK = join(CASE, "task.json");
const SOURCE_WORKSPACE = join(CASE, "workspace");

const IMPLEMENTATION = `export function slugify(value) {
  if (typeof value !== "string") throw new TypeError("value must be a string");
  return value
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`;

async function verifyModule(modulePath: string): Promise<void> {
  const imported = await import(`${pathToFileURL(modulePath).href}?v=${Date.now()}-${Math.random()}`) as {
    slugify: (value: unknown) => string;
  };
  assert.equal(imported.slugify("  Hello, World!  "), "hello-world");
  assert.equal(imported.slugify("Crème brûlée"), "creme-brulee");
  assert.equal(imported.slugify("---"), "");
  assert.equal(imported.slugify("a___b"), "a-b");
  assert.throws(() => imported.slugify(42), TypeError);
}

test("acceptance scenario 4: requirement implementation changes and verifies the real workspace", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "peak-requirement-"));
  const workspace = join(tempRoot, "workspace");
  cpSync(SOURCE_WORKSPACE, workspace, { recursive: true });
  const modulePath = join(workspace, "slug.mjs");
  const loaded = loadMockScenario(TASK);
  const graph = new TestGraph();
  const project = createScenarioProject(graph, loaded, workspace);
  const worker = new MockWorker();

  worker.register(/IMPLEMENT-SLUGIFY/i, async (request) => {
    assert.equal(request.cwd, workspace, "coding worker must receive the task workspace, not the session state directory");
    writeFileSync(join(request.cwd!, "slug.mjs"), IMPLEMENTATION, "utf8");
    await verifyModule(join(request.cwd!, "slug.mjs"));
    return env("fact", {
      description: "implemented requirement: slugify now validates type, normalizes diacritics, collapses separators and trims edge hyphens",
      evidence: [
        "slug.mjs: exported slugify implementation updated in assigned workspace",
        "executed checks: Hello World, Crème brûlée, punctuation-only, repeated separators and non-string TypeError",
      ],
      confidence: 0.99,
    });
  });
  worker.register(/# Evaluator Role/i, async () => {
    await verifyModule(modulePath);
    return env("verdict", {
      decision: "pass",
      reason: "independent evaluator execution covers every requirement against the changed module",
      confidence: 0.99,
    });
  });
  worker.register(/# Metacog Role/i, env("hints", { hints: [] }));
  worker.register(/automated planning module/i, () => {
    if (graph.intents(project.id).length === 0) {
      return decisions([{
        description: "IMPLEMENT-SLUGIFY: implement requirement.md and run focused behavior checks",
        from: [],
        dispatchExplorer: true,
      }]);
    }
    const accepted = graph.facts(project.id, "pass").find((fact) => /implemented requirement:/i.test(fact.description));
    return accepted
      ? decisions([], { description: "Requirement implemented and behavior verified", from: [accepted.id] })
      : decisions();
  });

  const bus = new TestFederationBus();
  const scope = "requirement-implementation";
  const supervisor = new GlobalSupervisor({ federationBus: bus, globalMaxConcurrent: 1 });
  supervisor.register(
    loaded.session,
    attachScenario(graph, worker, loaded.config, loaded.session, bus, scope),
    { projectId: project.id, scope },
  );

  try {
    assert.match(readFileSync(modulePath, "utf8"), /Not implemented/);
    await tickUntilCompleted(supervisor, [{ graph, projectId: project.id }]);

    assert.equal(graph.getProject(project.id)?.status, "completed");
    assert.doesNotMatch(readFileSync(modulePath, "utf8"), /Not implemented/);
    await verifyModule(modulePath);
    assert.ok(graph.facts(project.id, "pass").some((fact) => /implemented requirement:/i.test(fact.description)));
    assert.ok(graph.activeEndFact(project.id));
    assert.ok(worker.calls().some((call) => call.cwd === workspace && /IMPLEMENT-SLUGIFY/i.test(call.prompt)));
    assert.match(readFileSync(join(SOURCE_WORKSPACE, "slug.mjs"), "utf8"), /Not implemented/,
      "repository fixture must remain unchanged; implementation belongs to the task workspace copy");
  } finally {
    bus.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
