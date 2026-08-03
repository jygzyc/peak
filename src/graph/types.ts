export type ProjectStatus = "active" | "stopped" | "completed";

export interface FactRef { projectId: string; factId: string; description: string }
export interface ArtifactRef {
  path: string;         // Server 生成的 Project-relative 路径，固定为 artifacts/<sha256>
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  filename: string | null; // 可选的、基于内容的输出文件名；仅在完成时物化到 task.json 同目录
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
      .filter((intent) => intent.to !== null && intent.to.factId !== "goal")
      .flatMap((intent) => intent.from)
      .filter((ref) => ref.projectId === graph.project.id)
      .map((ref) => ref.factId),
  );
  return graph.facts.filter((fact) => fact.id !== "goal" && !superseded.has(fact.id));
}
