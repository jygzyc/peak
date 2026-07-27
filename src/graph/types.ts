export type ProjectStatus = "active" | "stopped" | "completed";

export interface FactRef { projectId: string; factId: string }
export interface ArtifactRef { path: string; sha256: string; mediaType: string; sizeBytes: number }
export interface Fact { id: string; description: string; artifact: ArtifactRef | null; createdAt: string }
export interface Intent {
  id: string;
  from: FactRef[];
  to: FactRef | null;
  description: string;
  createdBy: string;
  createdAt: string;
  concludedBy: string | null;
  concludedAt: string | null;
}
export interface Hint { id: string; content: string; creator: string; createdAt: string }
export interface ProjectMeta { id: string; title: string; status: ProjectStatus; scope?: string; createdAt: string }
export interface ProjectGraph { project: ProjectMeta; facts: Fact[]; intents: Intent[]; hints: Hint[] }

export interface CreateProjectInput { title: string; target: string; goal: string; scope?: string }
export interface CreateIntentInput { from: FactRef[]; description: string; createdBy: string }
export interface ConcludeInput { description: string; artifact?: ArtifactRef | null; concludedBy: string }
export interface CompleteInput { from: FactRef[]; description: string; completedBy: string }
export interface ReopenInput { description: string; creator: string }
export interface AddHintInput { content: string; creator: string }
