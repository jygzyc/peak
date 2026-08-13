import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GraphClient } from "../../dist/graph/graph-client.js";
import { GraphHttpServer } from "../../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../../dist/graph/project-store-registry.js";

test("completed Project archives carry Graph JSON, SQLite, and verified Artifacts into another Peak home", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-project-archive-"));
  const sourceHome = join(root, "source-home");
  const sourceProjects = join(sourceHome, "projects");
  const downloadedArchive = join(root, "downloaded.tar.gz");
  const cliArchive = join(root, "cli.tar.gz");
  const importedHome = join(root, "imported-home");
  let sourceRegistry = new ProjectStoreRegistry(sourceProjects);
  const server = new GraphHttpServer(sourceRegistry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  let projectId = "";
  let artifactHash = "";
  try {
    const project = await graph.createProject({ title: "Portable result", target: "start", goal: "portable goal" });
    projectId = project.id;
    const input = join(root, "result.md");
    writeFileSync(input, "portable evidence\n");
    const artifact = await graph.uploadArtifact(project.id, input, "text/markdown");
    artifactHash = artifact.sha256;
    await assert.rejects(
      sourceRegistry.exportProjectArchive(project.id, join(root, "active.tar.gz")),
      /only completed Projects/,
    );
    const intent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: "origin", description: "start" }],
      description: "Produce portable evidence",
      createdBy: "test",
    });
    const concluded = await graph.conclude(project.id, intent.id, {
      description: "Portable evidence is ready",
      artifact,
      concludedBy: "test",
    });
    await graph.complete(project.id, {
      from: [{ projectId: project.id, id: concluded.fact.id, description: concluded.fact.description }],
      description: "Portable goal proven",
      completedBy: "test",
    });
    await assert.rejects(
      sourceRegistry.exportProjectArchive(project.id, join(root, "missing-path-abstract.tar.gz")),
      /missing PathAbstract/,
    );
    await graph.putPathAbstract(project.id, concluded.fact.id, {
      factRef: { projectId: project.id, id: concluded.fact.id, description: concluded.fact.description },
      pathOverview: "Portable evidence proves the goal.",
      verifiedCore: ["The archived evidence is present."],
    });

    // A runtime scratch directory (.tmp) caches transient worker files and must
    // never leak into the portable Project archive.
    mkdirSync(join(sourceProjects, project.id, ".tmp"), { recursive: true });
    writeFileSync(join(sourceProjects, project.id, ".tmp", "pi-session.json"), "transient");

    await graph.downloadProjectArchive(project.id, downloadedArchive);
    assert.ok(existsSync(downloadedArchive));
    const targetRegistry = new ProjectStoreRegistry(join(root, "download-target", "projects"));
    try {
      const imported = await targetRegistry.importProjectArchive(downloadedArchive);
      assert.deepEqual(imported.boardProject, { id: project.id, source: "start", goal: "portable goal" });
      assert.equal(imported.project.status, "completed");
      assert.equal(readFileSync(join(targetRegistry.baseDir, project.id, "artifacts", artifact.sha256), "utf8"), "portable evidence\n");
      assert.ok(existsSync(join(targetRegistry.baseDir, project.id, "artifacts", `path_abs_${concluded.fact.id}`)));
      assert.ok(existsSync(join(targetRegistry.baseDir, project.id, "project.db")));
      assert.equal(existsSync(join(targetRegistry.baseDir, project.id, ".tmp")), false, ".tmp never enters the Project archive");
      assert.ok((await graph.exportProject(project.id)).includes(project.id));
      await assert.rejects(targetRegistry.importProjectArchive(downloadedArchive), /already exists/);
    } finally {
      targetRegistry.close();
    }
  } finally {
    await server.stop();
    sourceRegistry.close();
  }

  const exported = spawnSync(process.execPath, ["dist/cli.js", "export", projectId, cliArchive, "--peak-home", sourceHome], {
    cwd: process.cwd(), encoding: "utf8",
  });
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /\[peak] archive:/);
  const imported = spawnSync(process.execPath, ["dist/cli.js", "import", cliArchive, "--peak-home", importedHome], {
    cwd: process.cwd(), encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /add this block to board\.projects/);
  assert.match(imported.stdout, new RegExp(projectId));
  assert.equal(readFileSync(join(importedHome, "projects", projectId, "artifacts", artifactHash), "utf8"), "portable evidence\n");

  sourceRegistry = new ProjectStoreRegistry(join(importedHome, "projects"));
  try {
    assert.equal(sourceRegistry.get(projectId).graph.project()?.status, "completed");
  } finally {
    sourceRegistry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
