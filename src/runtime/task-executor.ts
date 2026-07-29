import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeExecutionInputDirectory } from "../config/paths.js";
import type { ResolvedTaskConfig, TaskProjectConfig, TaskType } from "../config/types.js";
import { FederationBus, type FederationReference } from "../graph/federation-bus.js";
import { GraphClient, GraphClientError } from "../graph/graph-client.js";
import { leafFacts, type FactRef, type Intent, type ProjectGraph } from "../graph/types.js";
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
const PHASE_TIMEOUT_MS = {
  plan: 45_000,
  supervise: 45_000,
  execute: 600_000,
  finalize: 120_000,
} as const;

export class TaskExecutor {
  constructor(
    private readonly config: ResolvedTaskConfig,
    private readonly projectConfig: TaskProjectConfig,
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
    const facts = leafFacts(project);
    const frontier: ProjectGraph = {
      project: project.project,
      facts,
      intents: project.intents.filter((intent) => intent.to === null),
      hints: project.hints,
    };
    const localRefs = facts.map((fact) => ({ projectId, factId: fact.id, description: fact.description }));
    const artifactInputs = await this.materialize(executionId, [
      ...facts.map((fact, index) => ({ ref: localRefs[index]!, fact })),
      ...resolved,
    ]);
    const path = writeGraphContext(this.projectDir, "plan", {
      phase: "plan", board: this.boardContext(), current: this.currentProject(), frontier,
      availableFactRefs: [...localRefs, ...pending], pending, resolved, artifactInputs,
    });
    const rendered = prompt("plan", path, planContract(this.config.phase.plan.maxIntents), this.config.board.skills);
    const worker = this.requireWorker("plan");
    const result = await this.workers.execute(worker, "plan", rendered, PHASE_TIMEOUT_MS.plan, this.config.board.workspace, signal);
    requireSuccess(result, "plan");
    const output = parsePlan(result.text, this.config.phase.plan.maxIntents);
    const visible = visibleRefs(projectId, frontier, pending);
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
    const artifactInputs = await this.materialize(executionId, project.facts.map((fact) => ({
      ref: { projectId, factId: fact.id, description: fact.description }, fact,
    })));
    const path = writeGraphContext(this.projectDir, "supervise", { phase: "supervise", board: this.boardContext(), current: this.currentProject(), graph: project, artifactInputs });
    const rendered = prompt("supervise", path, SUPERVISE_CONTRACT, this.config.board.skills);
    const worker = this.requireWorker("supervise");
    const result = await this.workers.execute(worker, "supervise", rendered, PHASE_TIMEOUT_MS.supervise, this.config.board.workspace, signal);
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
    const sources = await this.graph.resolveFactRefs(projectId, intent.from);
    const artifactInputs = await this.materialize(executionId, sources);
    const context = { phase: "execute", board: this.boardContext(), current: this.currentProject(), assignment: intent, sources, artifactInputs };
    const path = writeGraphContext(this.projectDir, "execute", context);
    const rendered = prompt("execute", path, EXECUTE_CONTRACT, this.config.board.skills);
    const worker = this.requireWorker("execute");
    const first = await this.workers.execute(worker, "execute", rendered, PHASE_TIMEOUT_MS.execute, this.config.board.workspace, signal);
    let output: ReturnType<typeof parseExecute>;
    try {
      if (first.returncode !== 0) throw new Error(`execute worker failed: ${preview(first.stderr)}`);
      output = parseExecute(first.text);
    } catch (error) {
      if (!first.started || first.cancelled || !first.session || signal?.aborted) throw error;
      const current = await this.graph.getProject(projectId);
      if (current.project.status !== "active" || !current.intents.some((item) => item.id === intent.id && item.to === null)) throw error;
      output = await this.finalize(worker, projectId, context, path, first.session, signal);
    }
    const artifact = output.artifact ? await this.upload(projectId, output.artifact.localPath, output.artifact.mediaType) : null;
    const concluded = await this.graph.conclude(projectId, intent.id, {
      description: output.description, artifact, concludedBy: `execute:${executionId}`,
    });
    this.federation.publish(
      { projectId, factId: concluded.fact.id, description: concluded.fact.description },
      intent.from.filter((ref) => ref.projectId === projectId),
    );
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
    const result = await this.workers.execute(worker, "execute", prompt("execute-finalize", path, EXECUTE_CONTRACT, this.config.board.skills), PHASE_TIMEOUT_MS.finalize, this.config.board.workspace, signal, session);
    requireSuccess(result, `finalize ${projectId}`);
    return parseExecute(result.text);
  }

  private async upload(projectId: string, localPath: string, mediaType: string) {
    if (isAbsolute(localPath)) throw new Error("artifact path must be relative to the workspace");
    const workspace = realpathSync(this.config.board.workspace);
    const candidate = resolve(workspace, localPath);
    const actual = realpathSync(candidate);
    const rel = relative(workspace, actual);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || lstatSync(candidate).isSymbolicLink()) {
      throw new Error("artifact path escapes workspace or is a symlink");
    }
    const stat = statSync(actual);
    if (!stat.isFile() || stat.size > this.config.phase.execute.maxArtifactBytes) throw new Error("invalid artifact file");
    return this.graph.uploadArtifact(projectId, actual, mediaType);
  }

  private async materialize(
    executionId: string,
    values: Array<{ ref: FactRef; fact: { artifact: { sha256: string } | null } }>,
  ): Promise<Array<{ ref: FactRef; path: string }>> {
    const output: Array<{ ref: FactRef; path: string }> = [];
    const root = initializeExecutionInputDirectory(executionId);
    for (const value of values) {
      if (!value.fact.artifact) continue;
      const path = join(root, value.fact.artifact.sha256);
      await this.graph.downloadArtifact(value.ref.projectId, value.fact.artifact.sha256, path);
      output.push({ ref: value.ref, path });
    }
    return output;
  }

  private boardContext(): object {
    return {
      name: this.config.board.name,
      workspace: this.config.board.workspace,
      skills: this.config.board.skills,
      projects: this.config.board.projects,
    };
  }

  private currentProject(): { id: string; name: string; goal: string } {
    return { id: this.projectConfig.id ?? "", name: this.projectConfig.name, goal: this.projectConfig.goal };
  }

  private requireWorker(taskType: TaskType): string {
    const worker = this.workers.pick(taskType);
    if (!worker) throw new Error(`no worker available for ${taskType}`);
    return worker;
  }
}

function prompt(name: string, graphPath: string, contract: string, skills: string[]): string {
  const candidates = [join(MODULE_DIR, "prompts", `${name}.md`), join(MODULE_DIR, "runtime", "prompts", `${name}.md`)];
  const path = candidates.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
  if (!path) throw new Error(`prompt not found: ${name}`);
  const template = readFileSync(path, "utf8");
  return template
    .replace("{graphPath}", () => graphPath)
    .replace("{skills}", () => JSON.stringify(skills))
    .replace("{contract}", () => contract);
}
function requireSuccess(result: WorkerResult, phase: string): void {
  if (result.returncode !== 0) throw new Error(`${phase} worker failed: ${preview(result.stderr)}`);
}
function preview(value: string): string { return value.replace(/\s+/g, " ").slice(0, 1_200); }
function visibleRefs(projectId: string, project: ProjectGraph, pending: FederationReference[]): Map<string, string> {
  return new Map([
    ...project.facts.map((fact): [string, string] => [`${projectId}/${fact.id}`, fact.description]),
    ...pending.map((ref): [string, string] => [`${ref.projectId}/${ref.factId}`, ref.description]),
  ]);
}
function validateVisible(refs: FactRef[], visible: Map<string, string>): void {
  for (const ref of refs) {
    const key = `${ref.projectId}/${ref.factId}`;
    if (!visible.has(key)) throw new Error(`FactRef is not visible: ${key}`);
    if (visible.get(key) !== ref.description) throw new Error(`FactRef description mismatch: ${key}`);
  }
}
function asRecord(value: unknown): Record<string, unknown> { return value as Record<string, unknown>; }

// A FactRef is an immutable hyperlink node {"projectId":"<id>","factId":"<existing fact id>","description":"<exact Fact description>"}.
// Copy all three fields exactly from an entry in `availableFactRefs`; never rewrite its description or add fields.
// Output ONLY the fields shown for each kind; put task context inside the Intent `description`.
const planContract = (maxIntents: number): string => `Output one JSON object. Use only the fields shown — no extra fields.
- {"kind":"intents","intents":[{"from":[{"projectId":"<id>","factId":"<existing fact id>","description":"<exact immutable Fact description>"}],"description":"<verifiable target of one atomic task, UTF-8 at most 2 KiB>"}]}  (1 to ${maxIntents} atomic intents, each with explicit inputs and a single checkable outcome; output {"kind":"noop"} if no new atomic task is needed)
- {"kind":"complete","from":[{"projectId":"<id>","factId":"<id>","description":"<exact immutable Fact description>"}],"description":"<concise proof summary, UTF-8 at most 2 KiB>"}
- {"kind":"noop"}`;
const SUPERVISE_CONTRACT = 'Output {"kind":"hint","content":"<concise hint, UTF-8 at most 1 KiB>"} or {"kind":"noop"}. Use only these fields — no extra fields.';
const EXECUTE_CONTRACT = 'Output {"kind":"fact","description":"<required concise summary, UTF-8 at most 1 KiB>","artifact":{"localPath":"<workspace-relative path>","mediaType":"text/markdown"}}. Use only these fields — no extra fields. Put detailed content in the Artifact; omit "artifact" only when the concise Fact description is sufficient.';
