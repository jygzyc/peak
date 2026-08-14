/**
 * Proof-DAG layout engine for the dashboard. Ported from the original
 * hand-written JS into typed TS; pure functions so the Lit component only
 * renders what this returns.
 */

export interface Ref {
  projectId: string;
  id: string;
  description: string;
}
export interface ArtifactModel {
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  filename: string | null;
  path?: string;
  inputPath?: string;
}
export interface FactModel {
  id: string;
  description: string;
  createdAt: string;
  artifact: ArtifactModel | null;
}
export interface IntentModel {
  id: string;
  from: Ref[];
  to: Ref | null;
  customProfile: string | null;
  customProfileDigest: string | null;
  hintIds: string[];
  description: string;
  createdBy: string;
  createdAt: string;
  concludedBy: string | null;
  concludedAt: string | null;
}
export interface HintModel {
  id: string;
  content: string;
  creator: string;
  createdAt: string;
  consumedByIntentId: string | null;
  consumedAt: string | null;
}
export interface GraphModel {
  project: { id: string; title: string; status: string; createdAt: string };
  facts: FactModel[];
  intents: IntentModel[];
  hints: HintModel[];
}
export interface ResolvedFact {
  id: string;
  description: string;
  createdAt: string;
  artifact: ArtifactModel | null;
}

export type NodeKind = "fact" | "external" | "hint";
export interface LayoutNode {
  key: string;
  type: NodeKind;
  id: string;
  projectId?: string;
  description: string;
  record: unknown;
  eventAt: string;
  introducedAt?: string;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  hintIndex?: number;
}
export interface Point { x: number; y: number }
export interface LayoutEdge {
  id: string;
  record: IntentModel;
  sources: LayoutNode[];
  target: LayoutNode | null;
  open: boolean;
  /** Open Intent carrying a pinned custom execution profile (customProfile/
   *  customProfileDigest set at creation). Persisted Graph state; orthogonal
   *  to open/concluded. */
  profiled: boolean;
  handle: Point;
  manual: boolean;
}
export interface LayoutModel {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  hintTop: number | null;
  pad: number;
}

export const NODE_GAP = 24;
export const INTENT_GAP = 16;

export function refKey(ref: Ref): string {
  return `${ref.projectId}:${ref.id}`;
}
export function splitRefKey(key: string): [string, string] {
  const index = key.lastIndexOf(":");
  return [key.slice(0, index), key.slice(index + 1)];
}

const LAYOUT_VERSION = "v6";
const nodeLayoutKey = (projectId: string) => `peak-graph-layout:${LAYOUT_VERSION}:${projectId}`;
const intentLayoutKey = (projectId: string) => `peak-intent-layout:${LAYOUT_VERSION}:${projectId}`;

export function readNodePositions(projectId: string): Record<string, Point> {
  try {
    return JSON.parse(localStorage.getItem(nodeLayoutKey(projectId)) ?? "{}") as Record<string, Point>;
  } catch {
    return {};
  }
}
export function readIntentPositions(projectId: string): Record<string, Point> {
  try {
    return JSON.parse(localStorage.getItem(intentLayoutKey(projectId)) ?? "{}") as Record<string, Point>;
  } catch {
    return {};
  }
}
export function saveNodePosition(projectId: string, node: LayoutNode): void {
  const positions = readNodePositions(projectId);
  positions[node.key] = { x: node.x, y: node.y };
  try {
    localStorage.setItem(nodeLayoutKey(projectId), JSON.stringify(positions));
  } catch { /* quota / privacy mode */ }
}
export function saveIntentPosition(projectId: string, edge: LayoutEdge): void {
  const positions = readIntentPositions(projectId);
  positions[edge.id] = { x: Math.round(edge.handle.x), y: Math.round(edge.handle.y) };
  try {
    localStorage.setItem(intentLayoutKey(projectId), JSON.stringify(positions));
  } catch { /* quota / privacy mode */ }
}
export function clearSavedLayouts(projectId: string): void {
  localStorage.removeItem(nodeLayoutKey(projectId));
  localStorage.removeItem(intentLayoutKey(projectId));
}

export function buildLayout(graph: GraphModel, resolved: Map<string, ResolvedFact>): LayoutModel {
  const W = 238, H = 104, XG = 126, YG = 46, PAD = 82, DAG_TOP = 78;
  const facts = new Map<string, LayoutNode>();
  const firstUse = new Map<string, string>();

  for (const intent of graph.intents) {
    for (const ref of intent.from) {
      if (ref.projectId === graph.project.id) continue;
      const key = refKey(ref);
      const current = firstUse.get(key);
      if (!current || intent.createdAt < current) firstUse.set(key, intent.createdAt);
    }
  }

  const completion = graph.intents.find((intent) => intent.to?.id === "goal");
  for (const fact of graph.facts) {
    const key = `${graph.project.id}:${fact.id}`;
    const eventAt = fact.id === "goal"
      ? completion?.concludedAt ?? completion?.createdAt ?? "99999999999999.999"
      : fact.createdAt;
    facts.set(key, {
      key, type: "fact", id: fact.id, description: fact.description, record: fact,
      eventAt, depth: fact.id === "origin" ? 0 : 1, x: 0, y: 0, w: W, h: H,
    });
  }
  for (const intent of graph.intents) {
    for (const ref of intent.from) {
      const key = refKey(ref);
      if (facts.has(key)) continue;
      const fact = resolved.get(key);
      const introducedAt = firstUse.get(key) ?? intent.createdAt;
      const publishedAt = fact?.createdAt;
      const eventAt = publishedAt
        ? (publishedAt > graph.project.createdAt ? publishedAt : graph.project.createdAt)
        : introducedAt;
      facts.set(key, {
        key, type: "external", id: ref.id, projectId: ref.projectId,
        description: ref.description, record: fact ?? ref,
        eventAt, introducedAt, depth: 0, x: 0, y: 0, w: W, h: H,
      });
    }
  }

  // First derive proof depth, then place an imported Fact beside the local
  // frontier that first used it instead of treating every import as a root.
  for (let pass = 0; pass < graph.intents.length + 2; pass++) {
    for (const intent of graph.intents) {
      if (!intent.to) continue;
      const target = facts.get(refKey(intent.to));
      if (!target) continue;
      const sourceDepth = Math.max(...intent.from.map((ref) => facts.get(refKey(ref))?.depth ?? 0));
      target.depth = Math.max(target.depth, sourceDepth + 1);
    }
  }
  for (const node of facts.values()) {
    if (node.type !== "external") continue;
    let frontier = 0;
    for (const intent of graph.intents) {
      if (!intent.from.some((ref) => refKey(ref) === node.key)) continue;
      for (const ref of intent.from) {
        const peer = facts.get(refKey(ref));
        if (peer && peer !== node) frontier = Math.max(frontier, peer.depth);
      }
    }
    node.depth = frontier;
  }
  for (let pass = 0; pass < graph.intents.length + 2; pass++) {
    for (const intent of graph.intents) {
      if (!intent.to) continue;
      const target = facts.get(refKey(intent.to));
      if (target) {
        target.depth = Math.max(target.depth, Math.max(...intent.from.map((ref) => facts.get(refKey(ref))?.depth ?? 0)) + 1);
      }
    }
  }

  let maxFactDepth = Math.max(0, ...[...facts.values()].map((node) => node.depth));
  const goal = facts.get(`${graph.project.id}:goal`);
  if (goal && !completion) {
    goal.depth = maxFactDepth + 1;
    maxFactDepth = goal.depth;
  }

  const layers = new Map<number, LayoutNode[]>();
  for (const node of facts.values()) {
    const list = layers.get(node.depth) ?? [];
    list.push(node);
    layers.set(node.depth, list);
  }
  for (const list of layers.values()) {
    list.sort((a, b) => nodeOrder(a) - nodeOrder(b) || a.eventAt.localeCompare(b.eventAt) || a.id.localeCompare(b.id));
  }
  const neighbors = optimizeLayerOrder(layers, graph, facts, maxFactDepth);

  const maxRows = Math.max(1, ...[...layers.values()].map((list) => list.length));
  const dagHeight = maxRows * H + (maxRows - 1) * YG;
  for (const list of layers.values()) {
    const used = list.length * H + (list.length - 1) * YG;
    const start = DAG_TOP + (dagHeight - used) / 2;
    list.forEach((node, index) => {
      node.y = start + index * (H + YG);
    });
  }
  relaxLayerPositions(layers, neighbors, DAG_TOP, dagHeight, H, YG, maxFactDepth);

  // Place Facts by proof depth, not creation time. Every layer shares one X
  // coordinate while the barycentric sweeps above balance related branches.
  const ordered = [...facts.values()].sort(
    (a, b) => a.depth - b.depth || a.y - b.y || nodeOrder(a) - nodeOrder(b) || a.id.localeCompare(b.id),
  );
  for (const node of ordered) node.x = PAD + node.depth * (W + XG);

  const saved = readNodePositions(graph.project.id);
  const placed: LayoutNode[] = [];
  for (const node of ordered) {
    const position = saved[node.key];
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      node.x = position.x;
      node.y = position.y;
    } else {
      const resolvedPos = resolveNodePosition(node, node.x, node.y, placed);
      node.x = resolvedPos.x;
      node.y = resolvedPos.y;
    }
    placed.push(node);
  }

  const rightmostFact = Math.max(PAD + W, ...ordered.map((node) => node.x + node.w));
  const width = Math.max(720, rightmostFact + 180) + PAD;
  const nodes = [...ordered];
  let hintTop: number | null = null;
  let baseHeight = Math.max(DAG_TOP + dagHeight, ...ordered.map((node) => node.y + node.h)) + PAD;

  const visibleHints = graph.hints;
  if (visibleHints.length) {
    const HW = 218, HH = 84, HG = 26;
    const columns = Math.max(1, Math.floor((width - PAD * 2 + HG) / (HW + HG)));
    const rows = Math.ceil(visibleHints.length / columns);
    hintTop = baseHeight + 55;
    visibleHints.forEach((hint, index) => {
      const node: LayoutNode = {
        key: `hint:${hint.id}`, type: "hint", id: hint.id,
        description: hint.content, record: hint,
        eventAt: hint.createdAt, depth: maxFactDepth + 1,
        x: PAD + (index % columns) * (HW + HG),
        y: hintTop! + Math.floor(index / columns) * (HH + HG),
        w: HW, h: HH, hintIndex: index,
      };
      const position = saved[node.key];
      if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        node.x = position.x;
        node.y = position.y;
      } else {
        const resolvedPos = resolveNodePosition(node, node.x, node.y, nodes);
        node.x = resolvedPos.x;
        node.y = resolvedPos.y;
      }
      nodes.push(node);
    });
    baseHeight = Math.max(hintTop + rows * HH + (rows - 1) * HG + PAD, ...nodes.map((node) => node.y + node.h + PAD));
  }

  const edges: LayoutEdge[] = [];
  for (const intent of graph.intents) {
    const sources = intent.from.map((ref) => facts.get(refKey(ref))).filter((node): node is LayoutNode => Boolean(node));
    if (!sources.length) continue;
    const target = intent.to ? facts.get(refKey(intent.to)) : null;
    if (intent.to && !target) continue;
    const open = !intent.to;
    // customProfile is a persistent execution-profile constraint, not a Worker
    // claim: the runtime's in-flight execution is never persisted to the Graph.
    const profiled = open && (intent.customProfile !== null || intent.customProfileDigest !== null);
    edges.push({ id: intent.id, record: intent, sources, target: target ?? null, open, profiled, handle: { x: 0, y: 0 }, manual: false });
  }
  placeIntentHandles(edges, nodes, graph.project.id);
  const rightmostEdge = Math.max(0, ...edges.map((edge) => edgeEnd(edge).x));
  return {
    nodes, edges,
    width: Math.max(width, rightmostEdge + PAD),
    height: baseHeight, hintTop, pad: PAD,
  };
}

function optimizeLayerOrder(
  layers: Map<number, LayoutNode[]>,
  graph: GraphModel,
  facts: Map<string, LayoutNode>,
  maxDepth: number,
): Map<string, LayoutNode[]> {
  const compare = (a: LayoutNode, b: LayoutNode) =>
    nodeOrder(a) - nodeOrder(b) || a.eventAt.localeCompare(b.eventAt) || a.id.localeCompare(b.id);
  const neighbors = new Map<string, LayoutNode[]>();
  for (const node of facts.values()) neighbors.set(node.key, []);
  for (const intent of graph.intents) {
    if (!intent.to) continue;
    const target = facts.get(refKey(intent.to));
    if (!target) continue;
    for (const ref of intent.from) {
      const source = facts.get(refKey(ref));
      if (source) {
        neighbors.get(target.key)!.push(source);
        neighbors.get(source.key)!.push(target);
      }
    }
  }
  for (let sweep = 0; sweep < 8; sweep++) {
    const depths = sweep % 2 ? [...Array(maxDepth + 1).keys()].reverse() : [...Array(maxDepth + 1).keys()];
    for (const depth of depths) {
      const list = layers.get(depth);
      if (!list || list.length < 2) continue;
      const current = new Map(list.map((node, index) => [node.key, index] as const));
      list.sort((a, b) => {
        const score = (node: LayoutNode) => {
          const values = (neighbors.get(node.key) ?? [])
            .filter((other) => (sweep % 2 ? other.depth > depth : other.depth < depth))
            .map((other) => (layers.get(other.depth) ?? []).indexOf(other));
          return values.length
            ? values.reduce((sum, value) => sum + value, 0) / values.length
            : current.get(node.key)!;
        };
        return score(a) - score(b) || compare(a, b);
      });
    }
  }
  return neighbors;
}

function relaxLayerPositions(
  layers: Map<number, LayoutNode[]>,
  neighbors: Map<string, LayoutNode[]>,
  top: number,
  height: number,
  nodeHeight: number,
  gap: number,
  maxDepth: number,
): void {
  for (let sweep = 0; sweep < 4; sweep++) {
    const depths = sweep % 2 ? [...Array(maxDepth + 1).keys()].reverse() : [...Array(maxDepth + 1).keys()];
    for (const depth of depths) {
      const list = layers.get(depth);
      if (!list?.length) continue;
      for (const node of list) {
        const linked = neighbors.get(node.key) ?? [];
        if (linked.length) {
          const target = linked.reduce((sum, other) => sum + other.y + other.h / 2, 0) / linked.length - nodeHeight / 2;
          node.y = node.y * 0.68 + target * 0.32;
        }
      }
      list.sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
      for (let index = 1; index < list.length; index++) {
        list[index].y = Math.max(list[index].y, list[index - 1].y + nodeHeight + gap);
      }
      for (let index = list.length - 2; index >= 0; index--) {
        list[index].y = Math.min(list[index].y, list[index + 1].y - nodeHeight - gap);
      }
      const center = (list[0].y + list[list.length - 1].y + nodeHeight) / 2;
      const shift = top + height / 2 - center;
      for (const node of list) node.y += shift;
    }
  }
}

export function intentLabel(edge: LayoutEdge): string {
  return edge.profiled ? `${edge.id} · OPEN · PROFILE` : edge.open ? `${edge.id} · OPEN` : edge.id;
}

export function intentLabelWidth(edge: LayoutEdge): number {
  return Math.max(38, intentLabel(edge).length * 6.2 + 16);
}

/**
 * The whole proof chain touching one Fact: the transitive closure of Intents
 * upstream (producers) and downstream (consumers), plus every Fact those
 * Intents connect. Used to spotlight a Fact's full lineage on selection.
 */
export function proofChain(graph: GraphModel, factKey: string): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>([factKey]);
  const edges = new Set<string>();
  const queue = [factKey];
  for (let index = 0; index < queue.length; index++) {
    const key = queue[index]!;
    for (const intent of graph.intents) {
      const upstream = intent.to !== null && refKey(intent.to) === key;
      const downstream = intent.from.some((ref) => refKey(ref) === key);
      if (!upstream && !downstream) continue;
      edges.add(intent.id);
      const related = intent.from.map(refKey);
      if (intent.to) related.push(refKey(intent.to));
      for (const other of related) {
        if (!nodes.has(other)) {
          nodes.add(other);
          queue.push(other);
        }
      }
    }
  }
  return { nodes, edges };
}

export function placeIntentHandles(edges: LayoutEdge[], nodes: LayoutNode[], projectId: string): void {
  const saved = readIntentPositions(projectId);
  const placed: LayoutEdge[] = [];
  for (const edge of edges) {
    const sourceCenters = edge.sources.map(nodeCenter);
    const source: Point = {
      x: sourceCenters.reduce((sum, p) => sum + p.x, 0) / sourceCenters.length,
      y: sourceCenters.reduce((sum, p) => sum + p.y, 0) / sourceCenters.length,
    };
    const target: Point = edge.target
      ? nodeCenter(edge.target)
      : { x: Math.max(...edge.sources.map((node) => node.x + node.w)) + 150, y: source.y };
    const wanted: Point = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
    if (edge.open) {
      wanted.x = target.x;
      wanted.y = target.y;
    }
    const position = saved[edge.id];
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      edge.handle = resolveIntentPosition(edge, position.x, position.y, nodes, placed);
      edge.manual = true;
    } else {
      const candidates: Point[] = [wanted, { x: wanted.x, y: source.y }, { x: wanted.x, y: target.y }];
      for (let ring = 1; ring <= 5; ring++) {
        candidates.push({ x: wanted.x, y: wanted.y + ring * 58 }, { x: wanted.x, y: wanted.y - ring * 58 });
      }
      let best: (Point & { score: number }) | null = null;
      for (const candidate of candidates) {
        if (intentPositionBlocked(edge, candidate.x, candidate.y, nodes, placed)) continue;
        const score = intentRouteScore(edge, candidate, nodes, placed) + Math.abs(candidate.y - wanted.y) * 0.015;
        if (!best || score < best.score) best = { ...candidate, score };
      }
      edge.handle = best
        ? { x: best.x, y: best.y }
        : resolveIntentPosition(edge, wanted.x, wanted.y, nodes, placed);
    }
    placed.push(edge);
  }
}

export function intentSegments(edge: LayoutEdge, handle: Point = edge.handle): [Point, Point][] {
  const end = edge.target ? nodeCenter(edge.target) : handle;
  const segments: [Point, Point][] = [];
  for (const source of edge.sources) {
    segments.push([nodeCenter(source), handle]);
    if (edge.target) segments.push([handle, end]);
  }
  return segments;
}

function intentRouteScore(edge: LayoutEdge, handle: Point, nodes: LayoutNode[], placed: LayoutEdge[]): number {
  const own = new Set<LayoutNode | null>([...edge.sources, edge.target].filter(Boolean));
  const segments = intentSegments(edge, handle);
  let score = 0;
  for (const [a, b] of segments) {
    for (const node of nodes) {
      if (node.type === "hint" || own.has(node)) continue;
      if (lineIntersectsRect(a, b, { x: node.x - 10, y: node.y - 10, w: node.w + 20, h: node.h + 20 })) score += 80;
    }
  }
  for (const other of placed) {
    for (const segment of segments) {
      for (const existing of intentSegments(other)) {
        if (segmentsCross(...segment, ...existing)) score += 24;
      }
    }
  }
  return score;
}

export function lineIntersectsRect(a: Point, b: Point, rect: { x: number; y: number; w: number; h: number }): boolean {
  if (a.x >= rect.x && a.x <= rect.x + rect.w && a.y >= rect.y && a.y <= rect.y + rect.h) return true;
  if (b.x >= rect.x && b.x <= rect.x + rect.w && b.y >= rect.y && b.y <= rect.y + rect.h) return true;
  const p1 = { x: rect.x, y: rect.y };
  const p2 = { x: rect.x + rect.w, y: rect.y };
  const p3 = { x: rect.x + rect.w, y: rect.y + rect.h };
  const p4 = { x: rect.x, y: rect.y + rect.h };
  return segmentsCross(a, b, p1, p2) || segmentsCross(a, b, p2, p3)
    || segmentsCross(a, b, p3, p4) || segmentsCross(a, b, p4, p1);
}

export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const turn = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const ab1 = turn(a, b, c), ab2 = turn(a, b, d);
  const cd1 = turn(c, d, a), cd2 = turn(c, d, b);
  return ab1 * ab2 < 0 && cd1 * cd2 < 0;
}

export function edgeEnd(edge: LayoutEdge): Point {
  return edge.open ? edge.handle : nodeCenter(edge.target!);
}

export function intentBox(edge: LayoutEdge, x: number = edge.handle.x, y: number = edge.handle.y): { x: number; y: number; w: number; h: number } {
  const width = intentLabelWidth(edge) + 20;
  return { x: x - width / 2, y: y - 20, w: width, h: 40 };
}

export function intentPositionBlocked(
  edge: LayoutEdge,
  x: number,
  y: number,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): boolean {
  const box = intentBox(edge, x, y);
  if (nodes.some((node) =>
    box.x < node.x + node.w + INTENT_GAP && box.x + box.w + INTENT_GAP > node.x
    && box.y < node.y + node.h + INTENT_GAP && box.y + box.h + INTENT_GAP > node.y)) {
    return true;
  }
  return edges.some((other) => {
    const target = intentBox(other);
    return box.x < target.x + target.w + INTENT_GAP && box.x + box.w + INTENT_GAP > target.x
      && box.y < target.y + target.h + INTENT_GAP && box.y + box.h + INTENT_GAP > target.y;
  });
}

export function resolveIntentPosition(
  edge: LayoutEdge,
  wantedX: number,
  wantedY: number,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  fallback: Point | null = null,
): Point {
  if (!intentPositionBlocked(edge, wantedX, wantedY, nodes, edges)) return { x: wantedX, y: wantedY };
  const angles = [Math.PI / 2, -Math.PI / 2, 0, Math.PI, Math.PI / 4, -Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4];
  for (let ring = 1; ring < 20; ring++) {
    for (const angle of angles) {
      const candidate = { x: wantedX + Math.cos(angle) * ring * 28, y: wantedY + Math.sin(angle) * ring * 28 };
      if (!intentPositionBlocked(edge, candidate.x, candidate.y, nodes, edges)) return candidate;
    }
  }
  return fallback ?? { x: wantedX, y: wantedY };
}

export function nodesOverlap(node: LayoutNode, x: number, y: number, other: LayoutNode): boolean {
  return x < other.x + other.w + NODE_GAP && x + node.w + NODE_GAP > other.x
    && y < other.y + other.h + NODE_GAP && y + node.h + NODE_GAP > other.y;
}

export function resolveNodePosition(
  node: LayoutNode,
  wantedX: number,
  wantedY: number,
  nodes: LayoutNode[],
  fallback: Point | null = null,
): Point {
  const others = nodes.filter((other) => other !== node);
  let x = wantedX, y = wantedY;
  for (let pass = 0; pass < Math.max(4, others.length * 3); pass++) {
    const conflicts = others.filter((other) => nodesOverlap(node, x, y, other));
    if (!conflicts.length) return { x, y };
    const candidates: Point[] = [];
    for (const other of conflicts) {
      candidates.push(
        { x: other.x - NODE_GAP - node.w, y },
        { x: other.x + other.w + NODE_GAP, y },
        { x, y: other.y - NODE_GAP - node.h },
        { x, y: other.y + other.h + NODE_GAP },
      );
    }
    candidates.sort((a, b) => {
      const aConflicts = others.reduce((count, other) => count + (nodesOverlap(node, a.x, a.y, other) ? 1 : 0), 0);
      const bConflicts = others.reduce((count, other) => count + (nodesOverlap(node, b.x, b.y, other) ? 1 : 0), 0);
      return aConflicts - bConflicts
        || Math.hypot(a.x - wantedX, a.y - wantedY) - Math.hypot(b.x - wantedX, b.y - wantedY);
    });
    if (!candidates.length) break;
    x = candidates[0].x;
    y = candidates[0].y;
  }
  if (fallback) return fallback;
  let guard = 0;
  while (others.some((other) => nodesOverlap(node, x, y, other)) && guard++ < others.length + 2) {
    const conflicts = others.filter((other) => nodesOverlap(node, x, y, other));
    y = Math.max(...conflicts.map((other) => other.y + other.h + NODE_GAP));
  }
  return { x, y };
}

export function nodeCenter(node: LayoutNode): Point {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

export function nodeAnchor(node: LayoutNode, toward: Point): Point {
  const center = nodeCenter(node);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (!dx && !dy) return center;
  const scale = 1 / Math.max(Math.abs(dx) / (node.w / 2), Math.abs(dy) / (node.h / 2));
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

export function curvedPath(a: Point, b: Point): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const bend = Math.max(28, Math.min(96, Math.abs(dx) * 0.38));
    const direction = Math.sign(dx) || 1;
    return `M ${a.x} ${a.y} C ${a.x + bend * direction} ${a.y}, ${b.x - bend * direction} ${b.y}, ${b.x} ${b.y}`;
  }
  const bend = Math.max(28, Math.min(88, Math.abs(dy) * 0.38));
  const direction = Math.sign(dy) || 1;
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + bend * direction}, ${b.x} ${b.y - bend * direction}, ${b.x} ${b.y}`;
}

function nodeOrder(node: LayoutNode): number {
  if (node.id === "origin") return -10;
  if (node.type === "external") return -5;
  if (node.id === "goal") return 10;
  if (node.type === "hint") return 20 + (node.hintIndex ?? 0);
  return 0;
}

export function intentColor(id: string, dark: boolean): string {
  const numeric = /^i(\d+)$/.exec(id);
  const seed = numeric
    ? Number(numeric[1])
    : [...id].reduce((value, ch) => (value * 33 + (ch.codePointAt(0) ?? 0)) >>> 0, 5381);
  const hue = (222 + (seed - 1) * 47) % 360;
  const light = dark ? 62 : 47;
  const sat = dark ? 46 : 42;
  return `hsl(${hue.toFixed(1)} ${sat}% ${light}%)`;
}

export interface NodeColors { fill: string; stroke: string; accent: string }

export function nodeColors(node: LayoutNode, dark: boolean): NodeColors {
  if (node.type === "hint") {
    return dark
      ? { fill: "#2a2213", stroke: "#8a6324", accent: "#e3b04e" }
      : { fill: "#fffaf0", stroke: "#e5aa4d", accent: "#b87413" };
  }
  if (node.type === "external") {
    return dark
      ? { fill: "#221c3d", stroke: "#6d4fd8", accent: "#a78bfa" }
      : { fill: "#ede9fe", stroke: "#7c3aed", accent: "#5b21b6" };
  }
  if (node.id === "origin") {
    return dark
      ? { fill: "#0e2b26", stroke: "#2ba08c", accent: "#4cd4c0" }
      : { fill: "#effcf8", stroke: "#32a996", accent: "#087f72" };
  }
  if (node.id === "goal") {
    return dark
      ? { fill: "#2c1218", stroke: "#c04f66", accent: "#f490a1" }
      : { fill: "#fff2f4", stroke: "#e27587", accent: "#bf3f56" };
  }
  return dark
    ? { fill: "#1a1f33", stroke: "#5a5ec9", accent: "#9ba0f5" }
    : { fill: "#f5f6ff", stroke: "#7168d5", accent: "#5146bd" };
}

function textWidth(value: string): number {
  let w = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    w += (code >= 0x2e80 && code <= 0x9fff) || code >= 0x3000 || (code >= 0xff00 && code <= 0xffef)
      ? 12
      : (ch === " " ? 3.5 : 6.7);
  }
  return w;
}

export function wrap(value: string, maxWidth: number, max: number): string[] {
  const chars = [...String(value).replace(/\s+/g, " ").trim()];
  const lines: string[] = [];
  while (chars.length && lines.length < max) {
    let width = 0, index = 0;
    while (index < chars.length) {
      const cw = textWidth(chars[index]);
      if (width + cw > maxWidth) break;
      width += cw;
      index++;
    }
    if (index === 0) index = 1;
    let end = index;
    if (end < chars.length) {
      let space = end;
      for (let i = end - 1; i >= 0; i--) {
        if (chars[i] === " ") { space = i; break; }
      }
      if (space > end * 0.45) end = space;
    }
    let line = chars.splice(0, end).join("").trim();
    while (chars[0] === " ") chars.shift();
    if (lines.length === max - 1 && chars.length) {
      let out = "", w2 = 0;
      for (const ch of line) {
        const cw = textWidth(ch);
        if (w2 + cw > maxWidth - textWidth("…")) break;
        out += ch;
        w2 += cw;
      }
      line = out + "…";
    }
    lines.push(line);
  }
  return lines.length ? lines : ["—"];
}
