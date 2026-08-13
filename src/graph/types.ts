export type ProjectStatus = "active" | "stopped" | "completed";

export interface FactRef { projectId: string; id: string; description: string }
export interface PathAbstract { factRef: FactRef; pathOverview: string; verifiedCore: string[] }
export interface ArtifactRef {
  path: string;         // Server-generated Project-relative path, fixed to artifacts/<sha256>
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  filename: string | null; // Optional content-based output filename; materialized under the task.json directory only on completion
}
export interface Fact { id: string; description: string; artifact: ArtifactRef | null; createdAt: string }
export interface Intent {
  id: string;
  from: FactRef[];
  to: FactRef | null;
  customProfile: string | null;
  customProfileDigest: string | null;
  hintIds: string[];
  description: string;
  createdBy: string;
  createdAt: string;
  concludedBy: string | null;
  concludedAt: string | null;
}
export interface Hint {
  id: string;
  content: string;
  creator: string;
  createdAt: string;
  consumedByIntentId: string | null;
  consumedAt: string | null;
}
export interface ProjectMeta { id: string; title: string; status: ProjectStatus; scope?: string; createdAt: string }
export interface ProjectGraph { project: ProjectMeta; facts: Fact[]; intents: Intent[]; hints: Hint[] }

export interface CreateProjectInput { title: string; target: string; goal: string; scope?: string }
export interface CreateIntentInput {
  from: FactRef[];
  customProfile?: string | null;
  customProfileDigest?: string | null;
  hintIds?: string[];
  description: string;
  createdBy: string;
}
export interface ConcludeInput { description: string; artifact: ArtifactRef | null; concludedBy: string }
export interface CompleteInput { from: FactRef[]; hintIds?: string[]; description: string; completedBy: string }
export interface ReopenInput { description: string; creator: string }
export interface AddHintInput { content: string; creator: string }

export interface ResolvedFactSource {
  ref: FactRef;
  fact: Omit<Fact, "artifact"> & {
    artifact: (Omit<ArtifactRef, "path"> & { inputPath: string; readOnly: true }) | null;
  };
}

/** Current proof frontier: Facts that have not produced a later local Fact. */
export function leafFacts(graph: ProjectGraph): Fact[] {
  const superseded = new Set(
    graph.intents
      .filter((intent) => intent.to !== null && intent.to.id !== "goal")
      .flatMap((intent) => intent.from)
      .filter((ref) => ref.projectId === graph.project.id)
      .map((ref) => ref.id),
  );
  return graph.facts.filter((fact) => fact.id !== "goal" && !superseded.has(fact.id));
}

/** One node of a Joint Plan Path: the Fact plus its producing Intent (null for roots such as origin). */
export interface PathStep { fact: FactRef; viaIntent: { id: string; description: string } | null }

/**
 * The Joint Plan unit: the full concluded ancestry of one leaf
 * Fact, split into segments. A segment extends through linear progressions
 * and breaks at merges (a Fact with multiple concluded sources) and forks (a
 * Fact feeding several concluded Intents). The Path's identity is the leaf
 * Fact id — leaf chain endpoints never repeat within one Project.
 */
export interface ProjectPath { projectId: string; leaf: FactRef; segments: PathStep[][]; truncated: boolean }

const MAX_PATH_NODES = 128;
const MAX_PATH_SEGMENTS = 32;

/**
 * Computes one Path per leaf Fact (or a single leaf when leafFactId is given):
 * the complete ancestor closure over ordinary concluded Intents. Completion
 * and `goal` are outside Joint Path analysis, so every Path ends at its
 * ordinary leaf `fN`. Open Intents form no edges. Returns [] for a fresh
 * Project without any ordinary concluded Intent.
 */
export function computePaths(graph: ProjectGraph, leafFactId?: string): ProjectPath[] {
  const projectId = graph.project.id;
  const concluded = graph.intents.filter((intent) => intent.to !== null && intent.to.id !== "goal");
  if (concluded.length === 0) return [];
  const facts = new Map(graph.facts.map((fact) => [fact.id, fact]));
  const ref = (fact: Fact): FactRef => ({ projectId, id: fact.id, description: fact.description });
  // predecessors: factId -> local concluded sources with the producing Intent
  const predecessors = new Map<string, Array<{ fromId: string; intent: { id: string; description: string } }>>();
  // producing: factId -> the Intent that created it (exactly one per Fact)
  const producing = new Map<string, { id: string; description: string }>();
  for (const intent of concluded) {
    const to = intent.to!;
    if (facts.has(to.id)) producing.set(to.id, { id: intent.id, description: intent.description });
    for (const from of intent.from) {
      if (from.projectId !== projectId || !facts.has(from.id)) continue;
      const list = predecessors.get(to.id) ?? [];
      list.push({ fromId: from.id, intent: { id: intent.id, description: intent.description } });
      predecessors.set(to.id, list);
    }
  }
  const terminals = leafFactId !== undefined
    ? graph.facts.filter((fact) => fact.id === leafFactId && fact.id !== "goal")
    : leafFacts(graph);
  const paths: ProjectPath[] = [];
  for (const leaf of terminals) {
    const path = buildPath(projectId, leaf, facts, ref, predecessors, producing);
    if (path) paths.push(path);
  }
  return paths;
}

function buildPath(
  projectId: string,
  leaf: Fact,
  facts: Map<string, Fact>,
  ref: (fact: Fact) => FactRef,
  predecessors: Map<string, Array<{ fromId: string; intent: { id: string; description: string } }>>,
  producing: Map<string, { id: string; description: string }>,
): ProjectPath | null {
  // Ancestor closure over local concluded edges (bounded).
  const closure = new Map<string, Fact>();
  let truncated = false;
  const queue = [leaf];
  while (queue.length > 0) {
    const fact = queue.shift()!;
    if (closure.has(fact.id)) continue;
    if (closure.size >= MAX_PATH_NODES) { truncated = true; break; }
    closure.set(fact.id, fact);
    for (const predecessor of predecessors.get(fact.id) ?? []) {
      const source = facts.get(predecessor.fromId);
      if (source) queue.push(source);
    }
  }
  const step = (fact: Fact): PathStep => ({ fact: ref(fact), viaIntent: producing.get(fact.id) ?? null });
  const inClosurePreds = (id: string) => (predecessors.get(id) ?? []).filter((entry) => closure.has(entry.fromId));
  // Chain children (exactly one in-closure predecessor) computed once as an
  // adjacency map instead of rescanning the closure for every node.
  const childrenOf = new Map<string, Fact[]>();
  for (const candidate of closure.values()) {
    const preds = inClosurePreds(candidate.id);
    if (preds.length !== 1) continue;
    const list = childrenOf.get(preds[0]!.fromId);
    if (list) list.push(candidate); else childrenOf.set(preds[0]!.fromId, [candidate]);
  }
  for (const list of childrenOf.values()) list.sort(compareFacts);
  const chainChildren = (id: string): Fact[] => childrenOf.get(id) ?? [];
  // Segment starts: roots (no in-closure predecessor) and merges (more than one).
  const starts = [...closure.values()].filter((fact) => inClosurePreds(fact.id).length !== 1).sort(compareFacts);
  const segments: PathStep[][] = [];
  const walk = (acc: Fact[]): void => {
    if (segments.length >= MAX_PATH_SEGMENTS) { truncated = true; return; }
    const children = chainChildren(acc[acc.length - 1]!.id);
    if (children.length === 0) { segments.push(acc.map(step)); return; }
    for (const child of children) walk([...acc, child]);
  };
  for (const start of starts) walk([start]);
  if (segments.length === 0) return null;
  segments.sort((a, b) => compareRefs(a[0]!.fact, b[0]!.fact));
  return { projectId, leaf: ref(leaf), segments, truncated };
}

function compareFacts(a: Fact, b: Fact): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
function compareRefs(a: FactRef, b: FactRef): number {
  return a.id.localeCompare(b.id);
}
