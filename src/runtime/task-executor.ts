import { createHash, randomBytes } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { localTimestamp, toJson, writeProjectLog } from "../utils/helpers.js";
import { initializeProjectLogsDirectory, projectOutDir, projectTmpDir } from "../utils/paths.js";
import { executeCapacity } from "../utils/task-config.js";
import {
  customProfileDigest, type CustomProfileDefinition, type ResolvedTaskConfig, type TaskProjectConfig, type TaskType,
} from "../utils/types.js";
import type { JointPlan } from "../graph/joint-plan.js";
import { GraphClient, GraphClientError } from "../graph/graph-client.js";
import {
  leafFacts, type Fact, type FactRef, type Hint, type Intent, type PathAbstract, type ProjectMeta, type ResolvedFactSource,
} from "../graph/types.js";
import type { SessionRef, WorkerResult } from "../worker/types.js";
import type { PlacedSource } from "./execution-backend.js";
import { parseAnalyze, parseExecute, parsePlan, parseSupervise } from "./contracts.js";
import { EMBEDDED_PROMPTS } from "../generated/assets.js";

type Phase = "plan" | "supervise" | "execute" | "finalize" | "analyze";
function writeGraphContext(projectDir: string, phase: Phase, executionId: string, value: unknown): string {
  const logs = initializeProjectLogsDirectory(projectDir);
  const path = join(logs, `graph-${localTimestamp()}-${executionId}-${phase}.json`);
  const temporary = join(logs, `.${executionId}-${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(temporary, toJson(value), { flag: "wx" });
  renameSync(temporary, path);
  return path;
}

export interface TaskWorkers {
  pick(taskType: TaskType): string | undefined;
  release(workerName: string, taskType: TaskType): void;
  execute(
    workerName: string,
    taskType: TaskType,
    prompt: string,
    timeoutMs: number,
    cwd: string,
    signal?: AbortSignal,
    session?: SessionRef,
    options?: { tmpDir?: string },
  ): Promise<WorkerResult>;
}

interface GraphViewBudget {
  truncated: boolean;
  omitted: Record<string, number>;
}
interface PlanProjectView {
  source: FactRef;
  goal: FactRef;
  leafFacts: ResolvedFactSource[];
  /** Digest is internal integrity metadata and is never shown to the Plan AI. */
  openIntents: Array<Omit<Intent, "customProfileDigest">>;
  unconsumedHints: Hint[];
}
interface PlanGraphView extends GraphViewBudget {
  projects: Record<string, PlanProjectView>;
  /** Path Abstract DTOs fetched from the central Server for same-Task leaves. */
  external: PathAbstract[];
}
interface ExecuteGraphView extends GraphViewBudget { project: ProjectMeta; intent: Intent; sources: ResolvedFactSource[] }
interface SuperviseGraphView extends GraphViewBudget {
  project: ProjectMeta;
  facts: Fact[];
  intents: Intent[];
  hints: Hint[];
}
interface RenderedPrompt { text: string; templateDigest: string }
interface ProfileValue { description: string; prompt: string; skills: string[]; digest: string }

export const GRAPH_VIEW_MAX_BYTES = 256 * 1024;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const PHASE_TIMEOUT_MS = { plan: 300_000, supervise: 300_000, execute: 600_000, finalize: 120_000, analyze: 300_000 } as const;
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
    private readonly jointPlan: JointPlan,
    readonly projectDir: string,
    private readonly onComplete: () => void = () => undefined,
    private workspace?: {
      tmpDir?: string;
      cleanup?: (dir: string) => void;
      placeArtifact?: (artifact: { sha256: string; filename: string | null }, content: Buffer) => Promise<PlacedSource>;
    },
  ) { validatePromptTemplates(); }

  /** Appends a runtime event to this Project's logs/main.log (e.g. retries, failures, crashes). */
  logEvent(type: string, data: Record<string, unknown>): void {
    writeProjectLog(this.projectDir, type, data);
  }

  /**
   * Replaces the execution workspace after a Project re-enters active state
   * inside the same Runtime (its Docker container was removed on the inactive
   * transition and re-created by `ensureWorkspace`). Only the owning
   * ProjectLoop calls this, between executions.
   */
  updateWorkspace(workspace: {
    tmpDir?: string;
    cleanup?: (dir: string) => void;
    placeArtifact?: (artifact: { sha256: string; filename: string | null }, content: Buffer) => Promise<PlacedSource>;
  }): void {
    this.workspace = workspace;
  }

  /** Reports Plan FactRefs whose descriptions were paraphrased and rewritten to the authoritative values. */
  private logNormalizedRefs(projectId: string, executionId: string, normalized: number): void {
    process.stderr.write(`[peak] plan normalized ${normalized} inexact FactRef description(s) to the authoritative values\n`);
    this.logEvent("factref_normalized", { projectId, executionId, normalized });
  }

  /**
   * Runs one worker round-trip and records it in the Project audit log:
   * `worker_started` before the spawn, and exactly one terminal event after —
   * `worker_completed` (exit 0), `worker_timeout` (the phase deadline killed
   * the worker), `worker_cancelled` (external abort), or `worker_failed`
   * (non-zero exit, with a stderr preview). Every attempt of a retried phase
   * gets its own event pair, so timeouts and flaky runs stay auditable. Each
   * event carries `projectId`, `phase`, `executionId` and (for Execute /
   * Finalize) `intentId`, pinpointing which Project's which step the worker
   * was running.
   *
   * A plain (non-async) function: `workers.execute` is invoked synchronously,
   * so a synchronous routing error propagates exactly as it did at the call
   * sites before (reservation release semantics unchanged).
   */
  private runWorker(
    projectId: string,
    phase: Phase,
    executionId: string,
    worker: string,
    taskType: TaskType,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
    session?: SessionRef,
    options?: { tmpDir?: string },
    intentId?: string,
  ): Promise<WorkerResult> {
    const startedAt = Date.now();
    this.logEvent("worker_started", {
      projectId, phase, executionId, worker, taskType, timeoutMs, intentId: intentId ?? null, sessionId: session?.value ?? null,
    });
    const running = this.workers.execute(worker, taskType, prompt, timeoutMs, this.prepareWorkerTmp(), signal, session, options);
    return running.then((result) => {
      const base = {
        projectId, phase, executionId, worker, taskType, timeoutMs, intentId: intentId ?? null,
        durationMs: Date.now() - startedAt, returncode: result.returncode, started: result.started,
      };
      if (result.timedOut) this.logEvent("worker_timeout", base);
      else if (result.cancelled) this.logEvent("worker_cancelled", base);
      else if (result.returncode !== 0) this.logEvent("worker_failed", { ...base, stderr: preview(result.stderr) });
      else this.logEvent("worker_completed", base);
      return result;
    });
  }

  reserveWorker(taskType: TaskType): string | undefined {
    return this.workers.pick(taskType);
  }

  /**
   * Joint Plan phase: recursively completes missing Path Abstracts for the
   * current Project and every same-Task peer, injects their current leaf Paths
   * into one read-only context, and validates the result against a fresh Graph.
   */
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
        const external = await this.prepareJointPlan(projectId, signal);
        const facts = leafFacts(project);
        const source = project.facts.find((fact) => fact.id === "origin");
        const goal = project.facts.find((fact) => fact.id === "goal");
        if (!source || !goal) throw new Error("Project source or goal Fact is missing");
        const refs = facts.map((fact) => factRef(projectId, fact));
        const resolvedLeaves = await this.graph.resolveFactRefs(projectId, refs);
        const placedLeaves = await this.materializeSources(resolvedLeaves);
        await this.verifySources(resolvedLeaves, placedLeaves);
        const current: PlanProjectView = {
          source: factRef(projectId, source),
          goal: factRef(projectId, goal),
          leafFacts: resolvedLeaves,
          openIntents: project.intents.filter((intent) => intent.to === null)
            .map(({ customProfileDigest: _, ...intent }) => intent),
          unconsumedHints: project.hints.filter((hint) => hint.consumedByIntentId === null),
        };
        const graph = budgetPlanGraphView(
          projectId,
          current,
          external,
        );
        const planProfile = profileValue(this.config.phase.plan.customProfile);
        // Profile selection happens by short digest token: descriptions are
        // long natural-language text the Plan AI frequently paraphrases, while
        // a 16-hex-char digest copies reliably.
        const executeProfiles = this.config.phase.execute.customProfile;
        const capacity = executeCapacity(this.config);
        const rendered = renderPrompt("plan", {
          customProfile: json(promptProfile(planProfile)), skills: json(planProfile?.skills ?? []),
          graph: json(graph), executeCustomProfiles: json(executeProfiles.map((profile) => ({
            description: profile.description, prompt: profile.prompt, digest: customProfileDigest(profile),
          }))),
          maxIntents: String(capacity),
          contract: planContract(capacity, executeProfiles.length > 0),
        });
        this.snapshot("plan", executionId, graph, planProfile, rendered);
        const output = await withPhaseRetries("plan", MAX_PHASE_ATTEMPTS, async () => {
          const result = await this.runWorker(projectId, "plan", executionId, worker, "plan", rendered.text, PHASE_TIMEOUT_MS.plan, signal, undefined, this.workerOptions());
          handedOff = true;
          requireSuccess(result, "plan");
          return phaseParse(() => parsePlan(result.text, executeCapacity(this.config), executeProfiles.map((profile) => ({
            description: profile.description, digest: customProfileDigest(profile),
          }))));
        }, signal, (attempt, attempts, message) => this.logEvent("phase_retry", { projectId, phase: "plan", executionId, attempt, attempts, message }));
        // Re-read immediately before writing so a source leaf consumed by a
        // concurrent Execute is caught under the latest leaf frontier, not the
        // snapshot the worker reasoned over.
        const latest = await this.graph.getProject(projectId);
        const visible = visibleRefs(projectId, leafFacts(latest));
        const unconsumedHints = latest.hints.filter((hint) => hint.consumedByIntentId === null);
        try {
          if (output.kind === "complete") {
            const normalized = validateVisible(output.from, visible);
            validateHints(output.hintIds, unconsumedHints);
            await this.graph.complete(projectId, {
              from: output.from, hintIds: output.hintIds, description: output.description, completedBy: `plan:${executionId}`,
            });
            await this.materializeDeliverables(projectId, output.from);
            this.onComplete();
            if (normalized > 0) this.logNormalizedRefs(projectId, executionId, normalized);
          } else if (output.kind === "intents") {
            let normalized = 0;
            for (const intent of output.intents) {
              normalized += validateVisible(intent.from, visible);
              validateHints(intent.hintIds, unconsumedHints);
              const selected = intent.customProfileDigest === null ? null : this.executeProfileByDigest(intent.customProfileDigest);
              await this.graph.createIntent(projectId, {
                from: intent.from, hintIds: intent.hintIds, description: intent.description,
                customProfile: selected?.description ?? null,
                customProfileDigest: selected?.digest ?? null,
                createdBy: `plan:${executionId}`,
              });
            }
            if (normalized > 0) this.logNormalizedRefs(projectId, executionId, normalized);
          }
          return;
        } catch (error) {
          if (!isStaleLeafConflict(error) || attempt === PLAN_DISPATCH_ATTEMPTS || signal?.aborted) throw error;
          const message = (error as Error).message;
          process.stderr.write(`[peak] plan retrying: a source leaf was consumed during planning (${message})\n`);
          this.logEvent("plan_retry", { projectId, executionId, message });
          await sleep(PHASE_RETRY_DELAY_MS, signal);
        }
      }
    } finally {
      if (!handedOff) this.workers.release(worker, "plan");
    }
  }

  /**
   * Supervise phase: shows the Worker the full Graph (Facts, Intents, Hints)
   * and lets it submit at most one Hint per round. Supervise can neither
   * create Facts/Intents nor complete/reopen the Project; duplicate Hint
   * content is dropped instead of re-written.
   */
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
        customProfile: json(promptProfile(selected)), skills: json(selected?.skills ?? []), graph: json(graph), contract: SUPERVISE_CONTRACT,
      });
      this.snapshot("supervise", executionId, graph, selected, rendered);
      const output = await withPhaseRetries("supervise", MAX_PHASE_ATTEMPTS, async () => {
        const result = await this.runWorker(projectId, "supervise", executionId, worker, "supervise", rendered.text, PHASE_TIMEOUT_MS.supervise, signal, undefined, this.workerOptions());
        handedOff = true;
        requireSuccess(result, "supervise");
        return phaseParse(() => parseSupervise(result.text));
      }, signal, (attempt, attempts, message) => this.logEvent("phase_retry", { projectId, phase: "supervise", executionId, attempt, attempts, message }));
      if (output.kind === "noop" || project.hints.some((hint) => hint.content.trim() === output.content.trim())) return;
      try {
        await this.graph.addHint(projectId, { content: output.content, creator: `supervise:${executionId}` });
      } catch (error) {
        if (!(error instanceof GraphClientError) || error.status !== 409) throw error;
      }
    } finally {
      if (!handedOff) this.workers.release(worker, "supervise");
    }
  }

  /**
   * Execute phase: resolves the open Intent's source FactRefs, runs the Worker
   * against the assembled view, verifies source Artifact integrity before and
   * after the run, and concludes the Intent with exactly one new local Fact
   * (optionally bound to one uploaded Artifact). A started but failed run gets
   * at most one Finalize resume over the same Worker session; failures leave
   * the Intent open for a later tick.
   */
  async execute(projectId: string, intent: Intent, executionId: string, signal?: AbortSignal, reservedWorker?: string): Promise<void> {
    const worker = reservedWorker ?? this.requireWorker("execute");
    let handedOff = false;
    try {
      const project = await this.graph.getProject(projectId);
      const sources = await this.graph.resolveFactRefs(projectId, intent.from);
      const placedSources = await this.materializeSources(sources);
      await this.verifySources(sources, placedSources);
      const selected = this.resolveExecuteProfile(intent);
      const graph: ExecuteGraphView = completeGraphView(
        { project: project.project, intent, sources }, ["sources"],
      );
      const rendered = renderPrompt("execute", {
        customProfile: json(promptProfile(selected)), skills: json(selected?.skills ?? []), graph: json(graph), contract: EXECUTE_CONTRACT,
      });
      const executeSnapshot = this.snapshot("execute", executionId, graph, selected, rendered);
      const running = this.runWorker(projectId, "execute", executionId, worker, "execute", rendered.text, PHASE_TIMEOUT_MS.execute, signal, undefined, this.workerOptions(), intent.id);
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
        output = await this.finalize(worker, projectId, executionId, graph, selected, executeSnapshot, first.session, signal, intent.id);
        finalized = true;
      }
      await this.verifySources(sources, placedSources);
      const artifact = output.artifact
        ? await this.uploadContent(projectId, output.artifact.filename, output.artifact.mediaType, output.artifact.content)
        : null;
      await this.graph.conclude(projectId, intent.id, {
        description: output.description, artifact, concludedBy: `${finalized ? "finalize" : "execute"}:${executionId}`,
      });
      // Path Abstracts are NOT generated here: Joint Plan recursively owns
      // them before the next Plan Worker call, keeping Execute one round-trip.
    } finally {
      if (!handedOff) this.workers.release(worker, "execute");
    }
  }

  /**
   * Runs immediately before every local Plan attempt. It first completes the
   * current Project's entire leaf PathAbstract frontier, then builds the Joint
   * Plan context from same-Task leaves. Analyze is recursive and incremental:
   * a cached `path_abs_fN` terminates recursion; otherwise all direct
   * predecessor abstracts are completed before Fact N.
   */
  async prepareJointPlan(projectId: string, signal?: AbortSignal): Promise<PathAbstract[]> {
    const local = await this.graph.getProject(projectId);
    for (const fact of leafFacts(local)) {
      if (fact.id !== "origin") await this.ensurePathAbstract(projectId, local, fact.id, signal, new Set());
    }
    const external: PathAbstract[] = [];
    for (const path of await this.jointPlan.paths(projectId)) {
      const source = await this.graph.getProject(path.projectId);
      const abstract = await this.ensurePathAbstract(path.projectId, source, path.leaf.id, signal, new Set());
      if (JSON.stringify(abstract.factRef) !== JSON.stringify(path.leaf)) {
        throw new Error(`Joint Plan PathAbstract FactRef mismatch: ${path.projectId}/${path.leaf.id}`);
      }
      external.push(abstract);
    }
    return external;
  }

  private async cachedPathAbstract(projectId: string, factId: string): Promise<PathAbstract | null> {
    try {
      return await this.graph.getPathAbstract(projectId, factId);
    } catch (error) {
      if (error instanceof GraphClientError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Builds one Fact's Path Abstract from that Fact and the already-verified
   * abstracts of its direct predecessors. This keeps Analyze incremental and
   * makes a merge explicit without replaying the whole ancestry.
   */
  private async ensurePathAbstract(
    projectId: string,
    graph: Awaited<ReturnType<GraphClient["getProject"]>>,
    factId: string,
    signal: AbortSignal | undefined,
    visiting: Set<string>,
  ): Promise<PathAbstract> {
    const cached = await this.cachedPathAbstract(projectId, factId);
    if (cached) return cached;
    const key = `${projectId}/${factId}`;
    if (visiting.has(key)) throw new Error(`PathAbstract dependency cycle at ${key}`);
    visiting.add(key);
    try {
      const fact = graph.facts.find((item) => item.id === factId);
      const producer = graph.intents.find((intent) => intent.to?.projectId === projectId && intent.to.id === factId);
      if (!fact || !producer) throw new Error(`PathAbstract source is missing: ${projectId}/${factId}`);
      const previous: Array<{ factRef: FactRef; abstract: PathAbstract | null }> = [];
      for (const ref of producer.from) {
        const abstract = ref.id === "origin"
          ? null
          : await this.ensurePathAbstract(
            ref.projectId,
            ref.projectId === projectId ? graph : await this.graph.getProject(ref.projectId),
            ref.id,
            signal,
            visiting,
          );
        previous.push({
          factRef: ref,
          abstract,
        });
      }
      const [current] = await this.graph.resolveFactRefs(projectId, [factRef(projectId, fact)]);
      if (!current) throw new Error(`Fact could not be resolved: ${projectId}/${factId}`);
      const placedCurrent = await this.materializeSources([current]);
      await this.verifySources([current], placedCurrent);
      const output = await this.analyzePath(projectId, current, previous, signal);
      return await this.graph.putPathAbstract(projectId, factId, { factRef: current.ref, ...output });
    } finally {
      visiting.delete(key);
    }
  }

  private async analyzePath(
    projectId: string,
    current: ResolvedFactSource,
    previous: Array<{ factRef: FactRef; abstract: PathAbstract | null }>,
    signal?: AbortSignal,
  ): Promise<Omit<PathAbstract, "factRef">> {
    const executionId = `analyze-${current.ref.id}`;
    let output: Omit<PathAbstract, "factRef">;
    const worker = this.workers.pick("plan");
    if (!worker) {
      output = fallbackAbstract(current, previous);
    } else {
      const context = { current, previous };
      const rendered = renderPrompt("analyze", {
        context: json(context), contract: ANALYZE_CONTRACT,
      });
      this.snapshot("analyze", executionId, context, null, rendered);
      try {
        output = await withPhaseRetries("analyze", MAX_PHASE_ATTEMPTS, async () => {
          const result = await this.runWorker(projectId, "analyze", executionId, worker, "plan", rendered.text, PHASE_TIMEOUT_MS.analyze, signal, undefined, this.workerOptions());
          requireSuccess(result, "analyze");
          return phaseParse(() => parseAnalyze(result.text));
        }, signal, (attempt, attempts, message) => this.logEvent("phase_retry", { projectId, phase: "analyze", executionId, attempt, attempts, message }));
      } catch (error) {
        if (signal?.aborted) throw error;
        this.logEvent("analyze_fallback", { projectId, leafFactId: current.ref.id, message: (error as Error).message });
        output = fallbackAbstract(current, previous);
      }
    }
    return output;
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
    intentId?: string,
  ): Promise<ReturnType<typeof parseExecute>> {
    const boundExecution = { executionId, snapshotPath: executeSnapshot };
    const rendered = renderPrompt("execute-finalize", {
      customProfile: json(promptProfile(selected)), skills: json(selected?.skills ?? []), graph: json(graph),
      boundExecution: json(boundExecution), contract: EXECUTE_CONTRACT,
    });
    this.snapshot("finalize", executionId, graph, selected, rendered, executionId);
    const result = await this.runWorker(projectId, "finalize", executionId, worker, "execute", rendered.text, PHASE_TIMEOUT_MS.finalize, signal, session, this.workerOptions(), intentId);
    requireSuccess(result, `finalize ${projectId}`);
    return parseExecute(result.text);
  }

  private executeProfile(description: string): ProfileValue {
    const definition = this.config.phase.execute.customProfile.find((profile) => profile.description === description);
    if (!definition) throw new Error(`unknown customProfile: ${description}`);
    return profileValue(definition);
  }

  private executeProfileByDigest(digest: string): ProfileValue {
    const definition = this.config.phase.execute.customProfile.find((profile) => customProfileDigest(profile) === digest);
    if (!definition) throw new Error(`unknown customProfile digest: ${digest}`);
    return profileValue(definition);
  }

  private resolveExecuteProfile(intent: Intent): ProfileValue | null {
    if (intent.customProfile === null || intent.customProfileDigest === null) {
      if (intent.customProfile !== null || intent.customProfileDigest !== null) throw new Error("Intent custom profile is incomplete");
      return null;
    }
    const profile = this.executeProfile(intent.customProfile);
    if (profile.digest !== intent.customProfileDigest) throw new Error(`Intent customProfile digest mismatch: ${intent.customProfile}`);
    return profile;
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
      customProfile: profile ? { description: profile.description, skills: profile.skills, digest: profile.digest } : null,
      configDigest: sha256(json(this.config)), renderedPromptSha256: sha256(rendered.text),
      executionId, at: localTimestamp(), boundExecutionId,
    });
  }

  /**
   * Materializes every source Artifact body into the execution substrate and
   * rewrites `artifact.inputPath` to the worker-visible copy. Content is taken
   * from the local Projects root when present (single-host deployments) and
   * otherwise fetched from the Graph server over HTTP, so Serve and Dispatch
   * may live on different hosts or use different Project roots. The returned
   * map is empty when the workspace cannot place Artifacts (direct legacy
   * execution): callers then verify the server-provided host paths as before.
   */
  private async materializeSources(sources: ResolvedFactSource[]): Promise<Map<string, PlacedSource>> {
    const placed = new Map<string, PlacedSource>();
    if (!this.workspace?.placeArtifact) return placed;
    for (const source of sources) {
      const artifact = source.fact.artifact;
      if (!artifact) continue;
      let content: Buffer;
      try {
        content = readFileSync(artifact.inputPath);
      } catch {
        // No local body: the Server owns the canonical bytes (remote dispatch
        // or a different Projects root). Fetch them over the Graph API.
        content = Buffer.from(await this.graph.artifactContent(source.ref.projectId, artifact.sha256), "utf8");
      }
      if (content.length !== artifact.sizeBytes) throw new Error(`Artifact size mismatch: ${artifact.sha256}`);
      if (sha256Bytes(content) !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${artifact.sha256}`);
      const entry = await this.workspace.placeArtifact({ sha256: artifact.sha256, filename: artifact.filename }, content);
      artifact.inputPath = entry.inputPath;
      placed.set(artifact.sha256, entry);
    }
    return placed;
  }

  /**
   * Verifies every source Artifact. Placed copies are hashed through the
   * workspace's host-side read handle (so tampering inside a docker container
   * is detected by pulling the file back out); without a placing workspace
   * the server-provided host paths are lstat + stream-hashed as before.
   */
  private async verifySources(sources: ResolvedFactSource[], placed: Map<string, PlacedSource>): Promise<void> {
    for (const source of sources) {
      const artifact = source.fact.artifact;
      if (artifact === null) continue;
      if (artifact.readOnly !== true) throw new Error(`invalid Artifact input path: ${source.ref.id}`);
      const entry = placed.get(artifact.sha256);
      if (entry) {
        const content = await entry.read();
        if (content.length !== artifact.sizeBytes) throw new Error(`Artifact size or type mismatch: ${artifact.sha256}`);
        if (sha256Bytes(content) !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${artifact.sha256}`);
        continue;
      }
      if (!isAbsolute(artifact.inputPath)) throw new Error(`invalid Artifact input path: ${source.ref.id}`);
      const stat = lstatSync(artifact.inputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.sizeBytes) {
        throw new Error(`Artifact size or type mismatch: ${artifact.sha256}`);
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(artifact.inputPath)) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${artifact.sha256}`);
    }
  }

  private async uploadContent(projectId: string, filename: string | null, mediaType: string, content: string) {
    return this.graph.uploadContent(projectId, content, mediaType, filename ?? undefined);
  }

  /** Materializes the final Goal deliverables under the Project `out/` directory using each completion-source Artifact's content-based filename. */
  private async materializeDeliverables(projectId: string, refs: FactRef[]): Promise<void> {
    const outDir = projectOutDir(this.projectDir);
    for (const ref of refs) {
      if (ref.projectId !== projectId) continue;
      const fact = await this.graph.getFact(ref);
      const artifact = fact.artifact;
      if (!artifact?.filename) continue;
      const outputPath = resolve(outDir, artifact.filename);
      const rel = relative(outDir, outputPath);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(artifact.filename)) {
        throw new Error(`deliverable filename escapes the output directory: ${artifact.filename}`);
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
   * Creates and returns the Project-scoped scratch directory used as every
   * Worker subprocess cwd. This contains relative files emitted by an Agent
   * CLI instead of allowing them to pollute the Board directory. Recreating
   * it here also supports an explicitly reopened Project after prior cleanup.
   */
  private prepareWorkerTmp(): string {
    const path = this.runtimeTmpDir();
    mkdirSync(path, { recursive: true });
    return path;
  }

  private runtimeTmpDir(): string {
    return this.workspace?.tmpDir ?? projectTmpDir(this.projectDir);
  }

  /**
   * Per-execute options shared by every phase dispatch: the Project-scoped
   * runtime scratch directory (`.tmp`, also used as the SDK session cwd and
   * for pi session files). Finalize reuses the Execute execution id.
   */
  private workerOptions(): { tmpDir: string } {
    return { tmpDir: this.runtimeTmpDir() };
  }

  /**
   * Best-effort removal of the per-Project runtime scratch directory
   * (`<projectDir>/.tmp`) that caches transient worker files such as CLI
   * session caches. It is never part of a Project archive and never stores
   * Fact Artifacts or deliverables. Called once the Project is no longer
   * active; idempotent and safe to retry every tick while it stays inactive.
   */
  cleanupRuntimeTmp(): void {
    const dir = this.runtimeTmpDir();
    if (this.workspace?.cleanup) { this.workspace.cleanup(dir); return; }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`[peak] failed to clean up runtime tmp: ${(error as Error).message}\n`);
    }
  }
}

function renderPrompt(name: string, replacements: Record<string, string>): RenderedPrompt {
  const template = loadPromptTemplate(name);
  const tokens = [...new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]!))];
  const unknown = tokens.find((token) => !(token in replacements));
  const unused = Object.keys(replacements).find((key) => !tokens.includes(key));
  if (unknown) throw new Error(`prompt ${name} has unknown token: {${unknown}}`);
  if (unused) throw new Error(`prompt ${name} does not use replacement: {${unused}}`);
  const text = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, token: string) => replacements[token]!);
  return { text, templateDigest: sha256(template) };
}

/** Embedded first, with the dist on-disk file as fallback (the dev flow and existing dist layout are unchanged). */
function loadPromptTemplate(name: string): string {
  const embedded = EMBEDDED_PROMPTS[name];
  if (embedded !== undefined) return embedded;
  const candidates = [join(MODULE_DIR, "prompts", `${name}.md`), join(MODULE_DIR, "runtime", "prompts", `${name}.md`)];
  const path = candidates.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
  if (!path) throw new Error(`prompt not found: ${name}`);
  return readFileSync(path, "utf8");
}

function validatePromptTemplates(): void {
  renderPrompt("plan", {
    customProfile: "null", skills: "[]", graph: "{}",
    executeCustomProfiles: "[]", maxIntents: "3", contract: "contract",
  });
  renderPrompt("supervise", { customProfile: "null", skills: "[]", graph: "{}", contract: "contract" });
  renderPrompt("execute", { customProfile: "null", skills: "[]", graph: "{}", contract: "contract" });
  renderPrompt("execute-finalize", {
    customProfile: "null", skills: "[]", graph: "{}", boundExecution: "{}", contract: "contract",
  });
  renderPrompt("analyze", { context: "{}", contract: "contract" });
}

/** Sha256 hex of raw bytes (Artifact bodies may be binary). */
function sha256Bytes(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function profileValue(profile: CustomProfileDefinition): ProfileValue;
function profileValue(profile: CustomProfileDefinition | undefined): ProfileValue | null;
function profileValue(profile: CustomProfileDefinition | undefined): ProfileValue | null {
  return profile ? { ...profile, digest: customProfileDigest(profile) } : null;
}
/** Keeps profile routing metadata out of the Worker instruction block. */
function promptProfile(profile: ProfileValue | null): Pick<ProfileValue, "description" | "prompt"> | null {
  return profile ? { description: profile.description, prompt: profile.prompt } : null;
}

/** Applies the shared byte budget without flattening the public Plan shape. */
function budgetPlanGraphView(
  projectId: string,
  current: PlanProjectView,
  external: PathAbstract[],
): PlanGraphView {
  const project = {
    ...current,
    leafFacts: [...current.leafFacts],
    openIntents: [...current.openIntents],
    unconsumedHints: [...current.unconsumedHints],
  };
  const view = { projects: { [projectId]: project }, external: [...external] };
  // Removal priority: peer PathAbstracts are drained first, then Hints, open
  // Intents, and the local leaf frontier last.
  return applyBudget(view, [
    { key: "external", values: view.external },
    { key: "unconsumedHints", values: project.unconsumedHints },
    { key: "openIntents", values: project.openIntents },
    { key: "leafFacts", values: project.leafFacts },
  ]);
}

interface BudgetList { key: string; values: unknown[] }

/**
 * Shared Graph view byte budget: pops one entry at a time from the first
 * non-empty list until the serialized view fits GRAPH_VIEW_MAX_BYTES. The
 * list order is the removal priority (the first list is drained first). The
 * input is never mutated; list arrays are supplied by the caller (cloned
 * where needed) and belong to the returned view.
 */
function applyBudget<T extends Record<string, unknown>>(view: T, lists: BudgetList[]): T & GraphViewBudget {
  const output = { ...view } as T & GraphViewBudget;
  const omitted: Record<string, number> = {};
  for (const { key } of lists) omitted[key] = 0;
  output.omitted = omitted;
  output.truncated = false;
  let size = Buffer.byteLength(json(output), "utf8");
  if (size <= GRAPH_VIEW_MAX_BYTES) return output;
  output.truncated = true;
  while (size > GRAPH_VIEW_MAX_BYTES) {
    const entry = lists.find(({ values }) => values.length > 0);
    if (!entry) throw new Error(`Graph view exceeds ${GRAPH_VIEW_MAX_BYTES} byte budget`);
    entry.values.pop();
    omitted[entry.key]! += 1;
    size = Buffer.byteLength(json(output), "utf8");
  }
  return output;
}

export function budgetGraphView<T extends Record<string, unknown>>(
  view: T,
  listKeys: Array<keyof T>,
): T & GraphViewBudget {
  const output = { ...view } as Record<string, unknown>;
  const lists: BudgetList[] = [];
  for (const key of listKeys) {
    const value = view[key];
    if (!Array.isArray(value)) throw new Error(`Graph view budget field is not an array: ${String(key)}`);
    const values = [...value];
    output[String(key)] = values;
    lists.push({ key: String(key), values });
  }
  // Removal priority: the last declared list is drained first.
  return applyBudget(output as T, lists.reverse()) as T & GraphViewBudget;
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
  onRetry?: (attempt: number, attempts: number, message: string) => void,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (!retryable(error, signal) || attempt === attempts) throw error;
      const message = (error as Error).message;
      process.stderr.write(`[peak] ${phase} attempt ${attempt}/${attempts} failed, retrying: ${message}\n`);
      onRetry?.(attempt, attempts, message);
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

function factRef(projectId: string, fact: { id: string; description: string }): FactRef {
  return { projectId, id: fact.id, description: fact.description };
}
function visibleRefs(projectId: string, facts: Array<{ id: string; description: string }>): Map<string, string> {
  return new Map(facts.map((fact): [string, string] => [`${projectId}/${fact.id}`, fact.description]));
}
/**
 * Validates that every ref points at a currently visible leaf Fact. Facts are
 * immutable, so a mismatched description is never a data race — it is the
 * Plan AI paraphrasing the text it was shown. The id is the identity: rewrite
 * such descriptions to the authoritative values instead of failing the round
 * (an inexact copy must not deadlock the Project), and report how many refs
 * were normalized so the caller can surface it. Missing keys are genuine
 * stale-leaf conflicts and keep throwing.
 */
function validateVisible(refs: FactRef[], visible: Map<string, string>): number {
  let normalized = 0;
  for (const ref of refs) {
    const key = `${ref.projectId}/${ref.id}`;
    const authoritative = visible.get(key);
    if (authoritative === undefined) throw new Error(`FactRef is not visible: ${key}`);
    if (ref.description !== authoritative) { ref.description = authoritative; normalized += 1; }
  }
  return normalized;
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
  `intents: {"kind":"intents","intents":[{"from":[{"projectId":"...","id":"...","description":"..."}],"hintIds":[]${hasProfiles ? ',"customProfileDigest":"<digest>"|null' : ""},"description":"..."}]} (1-${maxIntents})`,
  'complete: {"kind":"complete","from":[{"projectId":"...","id":"...","description":"..."}],"hintIds":[],"description":"..."}',
  'noop: {"kind":"noop"}',
  `Copy FactRefs exactly and select customProfileDigest by copying the exact 16-character digest listed in the Execute profiles${hasProfiles ? "" : " (no Execute profiles are configured; omit customProfileDigest)"}. Use no undeclared fields. Each Intent is one atomic transition to one Fact.`,
].join("\n");
const SUPERVISE_CONTRACT = '{"kind":"hint","content":"..."} or {"kind":"noop"}; content is at most 1 KiB UTF-8; no undeclared fields.';
const ANALYZE_CONTRACT = '{"pathOverview":"...","verifiedCore":["..."]}; 1-16 verifiedCore items; no undeclared fields.';

function fallbackAbstract(
  current: ResolvedFactSource,
  previous: Array<{ factRef: FactRef; abstract: PathAbstract | null }>,
): Omit<PathAbstract, "factRef"> {
  const prefix = previous.map((item) => item.abstract?.pathOverview ?? item.factRef.description);
  return {
    pathOverview: [...prefix, current.ref.description].join(" → "),
    verifiedCore: [current.ref.description],
  };
}
const EXECUTE_CONTRACT = 'Return exactly one JSON object with nothing before or after it (no prose, no code fences). {"kind":"fact","description":"<trimmed standalone summary, at most 1 KiB UTF-8>","artifact":null} or {"kind":"fact","description":"...","artifact":{"filename":"...","mediaType":"...","content":"<full file content, inline>"}}. Use only these fields; extra fields are rejected. If the result is longer than 1 KiB, keep description short and put the detail in the artifact content.';
