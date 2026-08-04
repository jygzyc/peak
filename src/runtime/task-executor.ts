import { createHash } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { customProfileDigest } from "../config/custom-profile.js";
import { executeCapacity } from "../config/task-config.js";
import type { CustomProfileDefinition, ResolvedTaskConfig, TaskProjectConfig, TaskType } from "../config/types.js";
import { localTimestamp } from "../graph/api.js";
import { FederationBus, type FederationReference } from "../graph/federation-bus.js";
import { GraphClient, GraphClientError } from "../graph/graph-client.js";
import {
  leafFacts, type Fact, type FactRef, type Hint, type Intent, type ProjectMeta, type ResolvedFactSource,
} from "../graph/types.js";
import type { SessionRef, WorkerResult } from "../worker/types.js";
import { parseExecute, parsePlan, parseSupervise } from "./contracts.js";
import { writeGraphContext, type Phase } from "./context.js";

export interface TaskWorkers {
  pick(taskType: TaskType): string | undefined;
  release(workerName: string): void;
  execute(
    workerName: string,
    taskType: TaskType,
    prompt: string,
    timeoutMs: number,
    cwd: string,
    signal?: AbortSignal,
    session?: SessionRef,
    options?: { sessionDir?: string; onSpawn?: (pid: number) => void },
  ): Promise<WorkerResult>;
}

export interface GraphViewBudget {
  truncated: boolean;
  omitted: Record<string, number>;
}
interface PlanGraphView extends GraphViewBudget {
  project: ProjectMeta;
  source: Fact;
  goal: Fact;
  leafFacts: Fact[];
  openIntents: Intent[];
  unconsumedHints: Hint[];
  pendingFactRefs: FactRef[];
}
interface ExecuteGraphView extends GraphViewBudget { project: ProjectMeta; intent: Intent; sources: ResolvedFactSource[] }
interface SuperviseGraphView extends GraphViewBudget {
  project: ProjectMeta;
  facts: Fact[];
  intents: Intent[];
  hints: Hint[];
}
interface RenderedPrompt { text: string; templateDigest: string }
interface ProfileValue { description: string; prompt: string; digest: string }

export const GRAPH_VIEW_MAX_BYTES = 256 * 1024;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PHASE_TIMEOUT_MS = { plan: 300_000, supervise: 300_000, execute: 600_000, finalize: 120_000 } as const;
// Fixed runtime policy (like phase timeouts, not Board-configurable): bounded
// retries absorb transient provider failures, timeouts, and malformed JSON
// output from a single worker round-trip.
const MAX_PHASE_ATTEMPTS = 3;
const PHASE_RETRY_DELAY_MS = 2_000;
/** Max Plan dispatches when a source leaf is consumed by a concurrent Execute. */
const PLAN_DISPATCH_ATTEMPTS = 2;

export class TaskExecutor {
  readonly deliverables: string[] = [];

  constructor(
    private readonly config: ResolvedTaskConfig,
    _projectConfig: TaskProjectConfig,
    private readonly graph: GraphClient,
    private readonly workers: TaskWorkers,
    private readonly federation: FederationBus,
    private readonly projectDir: string,
    private readonly onComplete: () => void = () => undefined,
    private readonly sessionDir?: string,
    private readonly reportSpawn?: (executionId: string, pid: number) => void,
  ) { validatePromptTemplates(); }

  reserveWorker(taskType: TaskType): string | undefined {
    return this.workers.pick(taskType);
  }

  async plan(projectId: string, executionId: string, signal?: AbortSignal, reservedWorker?: string): Promise<void> {
    const worker = reservedWorker ?? this.requireWorker("plan");
    let handedOff = false;
    try {
      // Plan reads a Graph view, asks the worker for the next Intents, then
      // writes them. A concurrent Execute can conclude an Intent while the
      // worker is thinking, consuming a source leaf the Plan reasoned over.
      // Rather than discard the round, the write is validated against a freshly
      // re-read Graph and the whole dispatch (re-read, re-plan, write) retries
      // when a source has been superseded.
      for (let attempt = 1; attempt <= PLAN_DISPATCH_ATTEMPTS; attempt += 1) {
        const project = await this.graph.getProject(projectId);
        const pending = this.federation.pendingFor(projectId);
        const facts = leafFacts(project);
        const source = project.facts.find((fact) => fact.id === "origin");
        const goal = project.facts.find((fact) => fact.id === "goal");
        if (!source || !goal) throw new Error("Project source or goal Fact is missing");
        const graph: PlanGraphView = completeGraphView({
          project: project.project,
          source,
          goal,
          leafFacts: facts,
          openIntents: project.intents.filter((intent) => intent.to === null),
          unconsumedHints: project.hints.filter((hint) => hint.consumedByIntentId === null),
          pendingFactRefs: pending,
        }, ["leafFacts", "openIntents", "unconsumedHints", "pendingFactRefs"]);
        const planProfile = profileValue(this.config.phase.plan.customProfile);
        const executeProfiles = this.config.phase.execute.customProfiles.map(profileValueRequired);
        const capacity = executeCapacity(this.config);
        const rendered = renderPrompt("plan", {
          customProfile: json(planProfile), skills: json(this.config.board.skills),
          source: json(graph.source), goal: json(graph.goal),
          graph: json(planCurrentState(graph)), executeCustomProfiles: json(executeProfiles),
          maxIntents: String(capacity),
          contract: planContract(capacity, executeProfiles.length > 0),
        });
        this.snapshot("plan", executionId, graph, planProfile, rendered);
        const output = await withPhaseRetries("plan", MAX_PHASE_ATTEMPTS, async () => {
          const result = await this.workers.execute(worker, "plan", rendered.text, PHASE_TIMEOUT_MS.plan, this.config.taskDir, signal, undefined, this.workerOptions(executionId));
          handedOff = true;
          requireSuccess(result, "plan");
          return phaseParse(() => parsePlan(result.text, executeCapacity(this.config), executeProfiles.map((profile) => profile.description)));
        }, signal);
        // Re-read immediately before writing so a source leaf consumed by a
        // concurrent Execute is caught under the latest leaf frontier, not the
        // snapshot the worker reasoned over.
        const latest = await this.graph.getProject(projectId);
        const visible = visibleRefs(projectId, leafFacts(latest), this.federation.pendingFor(projectId));
        const unconsumedHints = latest.hints.filter((hint) => hint.consumedByIntentId === null);
        try {
          if (output.kind === "complete") {
            validateVisible(output.from, visible);
            validateHints(output.hintIds, unconsumedHints);
            await this.graph.complete(projectId, {
              from: output.from, hintIds: output.hintIds, description: output.description, completedBy: `plan:${executionId}`,
            });
            await this.materializeDeliverables(projectId, output.from);
            this.onComplete();
          } else if (output.kind === "intents") {
            for (const intent of output.intents) {
              validateVisible(intent.from, visible);
              validateHints(intent.hintIds, unconsumedHints);
              const selected = intent.customProfile === null ? undefined
                : this.config.phase.execute.customProfiles.find((profile) => profile.description === intent.customProfile);
              if (intent.customProfile !== null && !selected) throw new Error(`unknown customProfile: ${intent.customProfile}`);
              await this.graph.createIntent(projectId, {
                from: intent.from, hintIds: intent.hintIds, description: intent.description,
                customProfile: selected?.description ?? null,
                customProfileDigest: selected ? customProfileDigest(selected) : null,
                createdBy: `plan:${executionId}`,
              });
            }
          }
          if (pending.length) this.federation.markHandled(projectId, pending);
          return;
        } catch (error) {
          if (!isStaleLeafConflict(error) || attempt === PLAN_DISPATCH_ATTEMPTS || signal?.aborted) throw error;
          process.stderr.write(`[peak] plan retrying: a source leaf was consumed during planning (${(error as Error).message})\n`);
          await sleep(PHASE_RETRY_DELAY_MS, signal);
        }
      }
    } finally {
      if (!handedOff) this.workers.release(worker);
    }
  }

  async supervise(projectId: string, executionId: string, signal?: AbortSignal, reservedWorker?: string): Promise<void> {
    const worker = reservedWorker ?? this.requireWorker("supervise");
    let handedOff = false;
    try {
      const project = await this.graph.getProject(projectId);
      const graph: SuperviseGraphView = budgetGraphView({
        project: project.project, facts: project.facts, intents: project.intents, hints: project.hints,
      }, ["facts", "intents", "hints"]);
      const selected = profileValue(this.config.phase.supervise.customProfile);
      const rendered = renderPrompt("supervise", {
        customProfile: json(selected), graph: json(graph), contract: SUPERVISE_CONTRACT,
      });
      this.snapshot("supervise", executionId, graph, selected, rendered);
      const output = await withPhaseRetries("supervise", MAX_PHASE_ATTEMPTS, async () => {
        const result = await this.workers.execute(worker, "supervise", rendered.text, PHASE_TIMEOUT_MS.supervise, this.config.taskDir, signal, undefined, this.workerOptions(executionId));
        handedOff = true;
        requireSuccess(result, "supervise");
        return phaseParse(() => parseSupervise(result.text));
      }, signal);
      if (output.kind === "noop" || project.hints.some((hint) => hint.content.trim() === output.content.trim())) return;
    try {
        await this.graph.addHint(projectId, { content: output.content, creator: `supervise:${executionId}` });
      } catch (error) {
        if (!(error instanceof GraphClientError) || error.status !== 409) throw error;
      }
    } finally {
      if (!handedOff) this.workers.release(worker);
    }
  }

  async execute(projectId: string, intent: Intent, executionId: string, signal?: AbortSignal, reservedWorker?: string): Promise<void> {
    const worker = reservedWorker ?? this.requireWorker("execute");
    let handedOff = false;
    try {
      const project = await this.graph.getProject(projectId);
      const sources = await this.graph.resolveFactRefs(projectId, intent.from);
      await verifySources(sources);
      const selected = this.resolveExecuteProfile(intent);
      const graph: ExecuteGraphView = completeGraphView(
        { project: project.project, intent, sources }, ["sources"],
      );
      const rendered = renderPrompt("execute", {
        customProfile: json(selected), skills: json(this.config.board.skills), graph: json(graph), contract: EXECUTE_CONTRACT,
      });
      const executeSnapshot = this.snapshot("execute", executionId, graph, selected, rendered);
      const running = this.workers.execute(worker, "execute", rendered.text, PHASE_TIMEOUT_MS.execute, this.config.taskDir, signal, undefined, this.workerOptions(executionId));
      handedOff = true;
      const first = await running;
      let output: ReturnType<typeof parseExecute>;
      let finalized = false;
    try {
        if (first.returncode !== 0) throw new Error(`execute worker failed: ${preview(first.stderr)}`);
        output = parseExecute(first.text);
      } catch (error) {
        if (!first.started || first.cancelled || !first.session || signal?.aborted) throw error;
        const current = await this.graph.getProject(projectId);
        if (current.project.status !== "active" || !current.intents.some((item) => item.id === intent.id && item.to === null)) throw error;
        output = await this.finalize(worker, projectId, executionId, graph, selected, executeSnapshot, first.session, signal);
        finalized = true;
      }
      await verifySources(sources);
      const artifact = output.artifact
        ? await this.uploadContent(projectId, output.artifact.filename, output.artifact.mediaType, output.artifact.content)
        : null;
      const concluded = await this.graph.conclude(projectId, intent.id, {
        description: output.description, artifact, concludedBy: `${finalized ? "finalize" : "execute"}:${executionId}`,
      });
      this.federation.publish(
        { projectId, factId: concluded.fact.id, description: concluded.fact.description },
        intent.from.filter((ref) => ref.projectId === projectId),
      );
    } finally {
      if (!handedOff) this.workers.release(worker);
    }
  }

  private async finalize(
    worker: string,
    projectId: string,
    executionId: string,
    graph: ExecuteGraphView,
    selected: ProfileValue | null,
    executeSnapshot: string,
    session: SessionRef,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseExecute>> {
    const boundExecution = { executionId, snapshotPath: executeSnapshot };
    const rendered = renderPrompt("execute-finalize", {
      customProfile: json(selected), skills: json(this.config.board.skills), graph: json(graph),
      boundExecution: json(boundExecution), contract: EXECUTE_CONTRACT,
    });
    this.snapshot("finalize", executionId, graph, selected, rendered, executionId);
    const result = await this.workers.execute(worker, "execute", rendered.text, PHASE_TIMEOUT_MS.finalize, this.config.taskDir, signal, session, this.workerOptions(executionId));
    requireSuccess(result, `finalize ${projectId}`);
    return parseExecute(result.text);
  }

  private resolveExecuteProfile(intent: Intent): ProfileValue | null {
    if (intent.customProfile === null || intent.customProfileDigest === null) {
      if (intent.customProfile !== null || intent.customProfileDigest !== null) throw new Error("Intent custom profile is incomplete");
      return null;
    }
    const definition = this.config.phase.execute.customProfiles.find((profile) => profile.description === intent.customProfile);
    if (!definition) throw new Error(`Intent references unconfigured customProfile: ${intent.customProfile}`);
    const digest = customProfileDigest(definition);
    if (digest !== intent.customProfileDigest) throw new Error(`Intent customProfile digest mismatch: ${intent.customProfile}`);
    return { ...definition, digest };
  }

  private snapshot(
    phase: Phase,
    executionId: string,
    context: unknown,
    profile: ProfileValue | null,
    rendered: RenderedPrompt,
    boundExecutionId: string | null = null,
  ): string {
    return writeGraphContext(this.projectDir, phase, executionId, {
      phase, templateVersion: rendered.templateDigest, context,
      customProfile: profile ? { description: profile.description, digest: profile.digest } : null,
      configDigest: sha256(json(this.config)), renderedPromptSha256: sha256(rendered.text),
      executionId, at: localTimestamp(), boundExecutionId,
    });
  }

  private async uploadContent(projectId: string, filename: string | null, mediaType: string, content: string) {
    return this.graph.uploadContent(projectId, content, mediaType, filename ?? undefined);
  }

  /** Materializes the final Goal deliverables next to task.json using each artifact's content-based filename. */
  private async materializeDeliverables(projectId: string, refs: FactRef[]): Promise<void> {
    const taskDir = resolve(this.config.taskDir);
    for (const ref of refs) {
      if (ref.projectId !== projectId) continue;
      const fact = await this.graph.getFact(ref);
      const artifact = fact.artifact;
      if (!artifact?.filename) continue;
      const outputPath = resolve(taskDir, artifact.filename);
      const rel = relative(taskDir, outputPath);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(artifact.filename)) {
        throw new Error(`deliverable filename escapes the Board directory: ${artifact.filename}`);
      }
      const content = await this.graph.artifactContent(projectId, artifact.sha256);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, content);
      this.deliverables.push(outputPath);
    }
  }

  private requireWorker(taskType: TaskType): string {
    const worker = this.workers.pick(taskType);
    if (!worker) throw new Error(`no worker available for ${taskType}`);
    return worker;
  }

  /**
   * Per-execute options shared by every phase dispatch: the Project-scoped
   * session directory (used by resumable CLI protocols such as Pi) and a
   * spawn callback that lets the Runtime record the child PID in its
   * ExecutionRegistry snapshot. Finalize reuses the Execute execution id so
   * the same PID slot is updated.
   */
  private workerOptions(executionId: string): { sessionDir?: string; onSpawn?: (pid: number) => void } {
    const options: { sessionDir?: string; onSpawn?: (pid: number) => void } = {};
    if (this.sessionDir) options.sessionDir = this.sessionDir;
    if (this.reportSpawn) options.onSpawn = (pid: number) => this.reportSpawn!(executionId, pid);
    return options;
  }
}

function renderPrompt(name: string, replacements: Record<string, string>): RenderedPrompt {
  const candidates = [join(MODULE_DIR, "prompts", `${name}.md`), join(MODULE_DIR, "runtime", "prompts", `${name}.md`)];
  const path = candidates.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
  if (!path) throw new Error(`prompt not found: ${name}`);
  const template = readFileSync(path, "utf8");
  const tokens = [...new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]!))];
  const unknown = tokens.find((token) => !(token in replacements));
  const unused = Object.keys(replacements).find((key) => !tokens.includes(key));
  if (unknown) throw new Error(`prompt ${name} has unknown token: {${unknown}}`);
  if (unused) throw new Error(`prompt ${name} does not use replacement: {${unused}}`);
  const text = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, token: string) => replacements[token]!);
  return { text, templateDigest: sha256(template) };
}

function validatePromptTemplates(): void {
  renderPrompt("plan", {
    customProfile: "null", skills: "[]", source: "source", goal: "goal", graph: "{}",
    executeCustomProfiles: "[]", maxIntents: "3", contract: "contract",
  });
  renderPrompt("supervise", { customProfile: "null", graph: "{}", contract: "contract" });
  renderPrompt("execute", { customProfile: "null", skills: "[]", graph: "{}", contract: "contract" });
  renderPrompt("execute-finalize", {
    customProfile: "null", skills: "[]", graph: "{}", boundExecution: "{}", contract: "contract",
  });
}

function planCurrentState(graph: PlanGraphView): Omit<PlanGraphView, "source" | "goal"> {
  const { source: _source, goal: _goal, ...current } = graph;
  return current;
}

async function verifySources(sources: ResolvedFactSource[]): Promise<void> {
  for (const source of sources) {
    const artifact = source.fact.artifact;
    if (artifact === null) continue;
    if (artifact.readOnly !== true || !isAbsolute(artifact.inputPath)) throw new Error(`invalid Artifact input path: ${source.ref.factId}`);
    const stat = lstatSync(artifact.inputPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.sizeBytes) {
      throw new Error(`Artifact size or type mismatch: ${artifact.sha256}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(artifact.inputPath)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${artifact.sha256}`);
  }
}

function profileValue(profile: CustomProfileDefinition | undefined): ProfileValue | null {
  return profile ? profileValueRequired(profile) : null;
}
function profileValueRequired(profile: CustomProfileDefinition): ProfileValue {
  return { ...profile, digest: customProfileDigest(profile) };
}
export function budgetGraphView<T extends Record<string, unknown>>(
  view: T,
  listKeys: Array<keyof T>,
): T & GraphViewBudget {
  const output = { ...view } as T & GraphViewBudget;
  const mutable = output as Record<string, unknown>;
  const omitted: Record<string, number> = {};
  for (const key of listKeys) {
    const value = view[key];
    if (!Array.isArray(value)) throw new Error(`Graph view budget field is not an array: ${String(key)}`);
    mutable[String(key)] = [...value];
    omitted[String(key)] = 0;
  }
  output.truncated = false;
  output.omitted = omitted;
  if (Buffer.byteLength(json(output), "utf8") <= GRAPH_VIEW_MAX_BYTES) return output;
  output.truncated = true;
  const removalOrder = [...listKeys].reverse();
  while (Buffer.byteLength(json(output), "utf8") > GRAPH_VIEW_MAX_BYTES) {
    let removed = false;
    for (const key of removalOrder) {
      const values = mutable[String(key)] as unknown[];
      if (!values.length) continue;
      values.pop();
      omitted[String(key)]! += 1;
      removed = true;
      if (Buffer.byteLength(json(output), "utf8") <= GRAPH_VIEW_MAX_BYTES) break;
    }
    if (!removed) throw new Error(`Graph view exceeds ${GRAPH_VIEW_MAX_BYTES} byte budget`);
  }
  return output;
}
function completeGraphView<T extends Record<string, unknown>>(
  view: T,
  listKeys: Array<keyof T>,
): T & GraphViewBudget {
  return {
    ...view,
    truncated: false,
    omitted: Object.fromEntries(listKeys.map((key) => [String(key), 0])),
  };
}
function json(value: unknown): string { return JSON.stringify(value, null, 2); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function requireSuccess(result: WorkerResult, phase: string): void {
  if (result.returncode !== 0) throw new PhaseAttemptError(`${phase} worker failed: ${preview(result.stderr)}`, result);
}

/** A single worker round-trip (run + strict contract parse) that failed. */
class PhaseAttemptError extends Error {
  constructor(message: string, readonly result: WorkerResult | null = null) {
    super(message);
    this.name = "PhaseAttemptError";
  }
}

/** Marks malformed worker output as a retryable attempt failure. */
function phaseParse<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) { throw new PhaseAttemptError((error as Error).message); }
}

/**
 * Bounded retry for idempotent read-only phases (Plan, Supervise): a single
 * model round-trip can fail transiently (provider error, timeout, malformed
 * JSON). Re-running the same prompt absorbs the flake before the dispatch is
 * reported failed. Only attempts that started and were not externally
 * cancelled are retried — the same predicate Execute uses for Finalize.
 */
async function withPhaseRetries<T>(
  phase: string,
  attempts: number,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (!retryable(error, signal) || attempt === attempts) throw error;
      process.stderr.write(`[peak] ${phase} attempt ${attempt}/${attempts} failed, retrying: ${(error as Error).message}\n`);
      await sleep(PHASE_RETRY_DELAY_MS, signal);
    }
  }
  throw last;
}

function retryable(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (!(error instanceof PhaseAttemptError)) return false;
  const result = error.result;
  return result === null || (result.started && !result.cancelled);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("cancelled")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
  });
}
function preview(value: string): string { return value.replace(/\s+/g, " ").slice(0, 1_200); }
function visibleRefs(projectId: string, facts: Array<{ id: string; description: string }>, pending: FederationReference[]): Map<string, string> {
  return new Map([
    ...facts.map((fact): [string, string] => [`${projectId}/${fact.id}`, fact.description]),
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

/**
 * True when a Plan write failed only because a source leaf was consumed by a
 * concurrent Execute while the worker was thinking: either the freshly re-read
 * Graph no longer lists it as a leaf (validateVisible), or the store rejected
 * the Intent/Completion with a 409 in the tiny window between re-read and
 * write. Such conflicts are transient and warrant re-planning from the latest
 * frontier instead of discarding the round.
 */
function isStaleLeafConflict(error: unknown): boolean {
  if (error instanceof GraphClientError && error.status === 409) {
    return /is not a current leaf/i.test(error.message);
  }
  return error instanceof Error && error.message.startsWith("FactRef is not visible:");
}
function validateHints(ids: string[], hints: Array<{ id: string }>): void {
  const visible = new Set(hints.map((hint) => hint.id));
  for (const id of ids) if (!visible.has(id)) throw new Error(`Hint is not available: ${id}`);
}

const planContract = (maxIntents: number, hasProfiles: boolean): string => [
  `intents: {"kind":"intents","intents":[{"from":[{"projectId":"...","factId":"...","description":"..."}],"hintIds":[]${hasProfiles ? ',"customProfile":null' : ""},"description":"..."}]} (1-${maxIntents})`,
  'complete: {"kind":"complete","from":[{"projectId":"...","factId":"...","description":"..."}],"hintIds":[],"description":"..."}',
  'noop: {"kind":"noop"}',
  'Copy FactRefs exactly. Use no undeclared fields. Each Intent is one atomic transition to one Fact.',
].join("\n");
const SUPERVISE_CONTRACT = '{"kind":"hint","content":"..."} or {"kind":"noop"}; no undeclared fields.';
const EXECUTE_CONTRACT = '{"kind":"fact","description":"...","artifact":null} or {"kind":"fact","description":"...","artifact":{"filename":"...","mediaType":"...","content":"..."}}; one optional file, inline content, no undeclared fields.';
