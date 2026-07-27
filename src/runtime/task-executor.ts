import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedTaskConfig, TaskType } from "../config/types.js";
import { FederationBus, type FederationReference } from "../graph/federation-bus.js";
import { GraphClient, GraphClientError } from "../graph/graph-client.js";
import type { FactRef, Intent, ProjectGraph } from "../graph/types.js";
import type { SessionRef, WorkerResult } from "../worker/types.js";
import { parseExecute, parsePlan, parseSupervise } from "./contracts.js";
import { writeGraphContext } from "./context.js";

export interface TaskWorkers {
  pick(taskType: TaskType): string | undefined;
  execute(
    workerName: string,
    taskType: TaskType,
    prompt: string,
    timeoutMs: number,
    cwd: string,
    signal?: AbortSignal,
    session?: SessionRef,
  ): Promise<WorkerResult>;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export class TaskExecutor {
  constructor(
    private readonly config: ResolvedTaskConfig,
    private readonly graph: GraphClient,
    private readonly workers: TaskWorkers,
    private readonly federation: FederationBus,
    private readonly projectDir: string,
    private readonly onComplete: () => void = () => undefined,
  ) {}

  async plan(projectId: string, executionId: string, signal?: AbortSignal): Promise<void> {
    const project = await this.graph.getProject(projectId);
    const pending = this.federation.pendingFor(projectId);
    const resolved = pending.length ? await this.graph.resolveFactRefs(projectId, pending) : [];
    const artifactInputs = await this.materialize(executionId, [
      ...project.facts.map((fact) => ({ ref: { projectId, factId: fact.id }, fact })),
      ...resolved,
    ]);
    const path = writeGraphContext(this.projectDir, "plan", { phase: "plan", task: this.config.task, graph: project, pending, resolved, artifactInputs });
    const rendered = prompt("plan", path, PLAN_CONTRACT);
    const worker = this.requireWorker("plan");
    const result = await this.workers.execute(worker, "plan", rendered, this.config.tasks.plan.timeoutMs, this.config.task.workspace, signal);
    requireSuccess(result, "plan");
    const output = parsePlan(result.text, this.config.tasks.plan.maxIntents);
    const visible = visibleRefs(project, pending);
    if (output.kind === "complete") {
      validateVisible(output.from, visible);
      await this.graph.complete(projectId, { from: output.from, description: output.description, completedBy: `plan:${executionId}` });
      this.onComplete();
    } else if (output.kind === "intents") {
      for (const intent of output.intents) {
        validateVisible(intent.from, visible);
        await this.graph.createIntent(projectId, { ...intent, createdBy: `plan:${executionId}` });
      }
    }
    if (pending.length) this.federation.markHandled(projectId, pending);
  }

  async supervise(projectId: string, executionId: string, signal?: AbortSignal): Promise<void> {
    const project = await this.graph.getProject(projectId);
    const artifactInputs = await this.materialize(executionId, project.facts.map((fact) => ({ ref: { projectId, factId: fact.id }, fact })));
    const path = writeGraphContext(this.projectDir, "supervise", { phase: "supervise", task: this.config.task, graph: project, artifactInputs });
    const rendered = prompt("supervise", path, SUPERVISE_CONTRACT);
    const worker = this.requireWorker("supervise");
    const result = await this.workers.execute(worker, "supervise", rendered, this.config.tasks.supervise.timeoutMs, this.config.task.workspace, signal);
    requireSuccess(result, "supervise");
    const output = parseSupervise(result.text);
    if (output.kind === "noop" || project.hints.some((hint) => hint.content.trim() === output.content.trim())) return;
    try {
      await this.graph.addHint(projectId, { content: output.content, creator: `supervise:${executionId}` });
    } catch (error) {
      if (!(error instanceof GraphClientError) || error.status !== 409) throw error;
    }
  }

  async execute(projectId: string, intent: Intent, executionId: string, signal?: AbortSignal): Promise<void> {
    const project = await this.graph.getProject(projectId);
    const sources = await this.graph.resolveFactRefs(projectId, intent.from);
    const artifactInputs = await this.materialize(executionId, sources);
    const context = { phase: "execute", task: this.config.task, graph: project, assignment: intent, sources, artifactInputs };
    const path = writeGraphContext(this.projectDir, "execute", context);
    const rendered = prompt("execute", path, EXECUTE_CONTRACT);
    const worker = this.requireWorker("execute");
    const first = await this.workers.execute(worker, "execute", rendered, this.config.tasks.execute.timeoutMs, this.config.task.workspace, signal);
    let output: ReturnType<typeof parseExecute>;
    try {
      if (first.returncode !== 0) throw new Error(`execute worker failed: ${preview(first.stderr)}`);
      output = parseExecute(first.text);
    } catch (error) {
      const recoverable = first.timedOut || first.returncode === 0;
      if (!recoverable || !first.started || first.cancelled || !first.session || signal?.aborted) throw error;
      const current = await this.graph.getProject(projectId);
      if (current.project.status !== "active" || !current.intents.some((item) => item.id === intent.id && item.to === null)) throw error;
      output = await this.finalize(worker, projectId, context, path, first.session, signal);
    }
    const artifact = output.artifact ? await this.upload(projectId, output.artifact.localPath, output.artifact.mediaType) : null;
    const concluded = await this.graph.conclude(projectId, intent.id, {
      description: output.description, artifact, concludedBy: `execute:${executionId}`,
    });
    this.federation.publish({ projectId, factId: concluded.fact.id }, intent.description);
  }

  private async finalize(
    worker: string,
    projectId: string,
    context: unknown,
    executePath: string,
    session: SessionRef,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseExecute>> {
    const path = writeGraphContext(this.projectDir, "finalize", { ...asRecord(context), boundExecuteContext: executePath });
    const result = await this.workers.execute(worker, "execute", prompt("execute-finalize", path, EXECUTE_CONTRACT), this.config.tasks.execute.finalizeTimeoutMs, this.config.task.workspace, signal, session);
    requireSuccess(result, `finalize ${projectId}`);
    return parseExecute(result.text);
  }

  private async upload(projectId: string, localPath: string, mediaType: string) {
    if (isAbsolute(localPath)) throw new Error("artifact path must be relative to the workspace");
    const workspace = realpathSync(this.config.task.workspace);
    const candidate = resolve(workspace, localPath);
    const actual = realpathSync(candidate);
    const rel = relative(workspace, actual);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || lstatSync(candidate).isSymbolicLink()) {
      throw new Error("artifact path escapes workspace or is a symlink");
    }
    const stat = statSync(actual);
    if (!stat.isFile() || stat.size > this.config.tasks.execute.maxArtifactBytes) throw new Error("invalid artifact file");
    return this.graph.uploadArtifact(projectId, actual, mediaType);
  }

  private async materialize(
    executionId: string,
    values: Array<{ ref: FactRef; fact: { artifact: { sha256: string } | null } }>,
  ): Promise<Array<{ ref: FactRef; path: string }>> {
    const output: Array<{ ref: FactRef; path: string }> = [];
    const root = join(tmpdir(), "peak-inputs", executionId);
    for (const value of values) {
      if (!value.fact.artifact) continue;
      mkdirSync(root, { recursive: true });
      const path = join(root, value.fact.artifact.sha256);
      await this.graph.downloadArtifact(value.ref.projectId, value.fact.artifact.sha256, path);
      output.push({ ref: value.ref, path });
    }
    return output;
  }

  private requireWorker(taskType: TaskType): string {
    const worker = this.workers.pick(taskType);
    if (!worker) throw new Error(`no worker available for ${taskType}`);
    return worker;
  }
}

function prompt(name: string, graphPath: string, contract: string): string {
  const candidates = [join(MODULE_DIR, "prompts", `${name}.md`), join(MODULE_DIR, "runtime", "prompts", `${name}.md`)];
  const path = candidates.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
  if (!path) throw new Error(`prompt not found: ${name}`);
  const template = readFileSync(path, "utf8");
  return template.replace("{graphPath}", graphPath).replace("{contract}", contract);
}
function requireSuccess(result: WorkerResult, phase: string): void {
  if (result.returncode !== 0) throw new Error(`${phase} worker failed: ${preview(result.stderr)}`);
}
function preview(value: string): string { return value.replace(/\s+/g, " ").slice(0, 1_200); }
function visibleRefs(project: ProjectGraph, pending: FederationReference[]): Set<string> {
  return new Set([...project.facts.map((fact) => `${project.project.id}/${fact.id}`), ...pending.map((ref) => `${ref.projectId}/${ref.factId}`)]);
}
function validateVisible(refs: FactRef[], visible: Set<string>): void {
  for (const ref of refs) if (!visible.has(`${ref.projectId}/${ref.factId}`)) throw new Error(`FactRef is not visible: ${ref.projectId}/${ref.factId}`);
}
function asRecord(value: unknown): Record<string, unknown> { return value as Record<string, unknown>; }

// A FactRef is an object {"projectId":"<id>","factId":"<existing fact id>"} — never a bare string.
// Use only fact ids that already exist in the Graph (for example "origin").
const PLAN_CONTRACT = `Output one JSON object:
- {"kind":"intents","intents":[{"from":[{"projectId":"<this project id>","factId":"origin"}],"description":"..."}]}  (1 to 4 intents; if there is no new work, output {"kind":"noop"} instead of an empty array)
- {"kind":"complete","from":[{"projectId":"<id>","factId":"<id>"}],"description":"..."}
- {"kind":"noop"}`;
const SUPERVISE_CONTRACT = 'Output {"kind":"hint","content":"..."} or {"kind":"noop"}.';
const EXECUTE_CONTRACT = 'Output {"kind":"fact","description":"<required, self-contained>","artifact":{"localPath":"<workspace-relative path>","mediaType":"text/markdown"}}. The "artifact" field is optional; omit it for short results.';
