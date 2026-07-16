import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type {
  AgentId,
  AgentRecord,
  FactId,
  IntentId,
  RoleId,
  WorkerName,
} from "./types.js";

export interface CreateAgentRecordInput {
  sessionId: string;
  projectId: string;
  profileId: string;
  role: RoleId;
  workerName: WorkerName;
  intentId?: IntentId;
  factId?: FactId;
  inputSummary?: string;
}

export type AgentRecordPatch = Partial<Omit<AgentRecord,
  "version" | "id" | "sessionId" | "projectId" | "profileId" | "role" | "workerName"
  | "createdAt" | "startedAt"
>>;

/** JSON audit store for role executions. It is deliberately separate from Graph. */
export class AgentRecordStore {
  constructor(private readonly sessionDir: string) {}

  async create(input: CreateAgentRecordInput): Promise<AgentRecord> {
    const timestamp = new Date().toISOString();
    const record: AgentRecord = {
      version: 1,
      id: newAgentId(),
      ...input,
      status: "running",
      createdAt: timestamp,
      startedAt: timestamp,
    };
    await this.write(record);
    return record;
  }

  async update(agentId: AgentId, patch: AgentRecordPatch): Promise<AgentRecord> {
    const current = await this.get(agentId);
    if (!current) throw new Error(`agent record not found: ${agentId}`);
    const record = { ...current, ...patch };
    if (isTerminal(record.status) && !record.finishedAt) record.finishedAt = new Date().toISOString();
    await this.write(record);
    return record;
  }

  async get(agentId: AgentId): Promise<AgentRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.recordPath(agentId), "utf8")) as AgentRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<AgentRecord[]> {
    const root = this.agentsDir();
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const records = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.get(entry.name)));
      return records.filter((record): record is AgentRecord => Boolean(record))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(record: AgentRecord): Promise<void> {
    const directory = resolve(this.agentsDir(), record.id);
    assertWithin(this.sessionDir, directory);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private agentsDir(): string {
    return resolve(this.sessionDir, "agents");
  }

  private recordPath(agentId: AgentId): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(agentId)) throw new Error(`invalid agent id: ${agentId}`);
    const path = resolve(this.agentsDir(), agentId, "record.json");
    assertWithin(this.sessionDir, path);
    return path;
  }
}

export function newAgentId(): AgentId {
  return `agent_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function isTerminal(status: AgentRecord["status"]): boolean {
  return status !== "running";
}

function assertWithin(rootPath: string, candidate: string): void {
  const root = resolve(rootPath);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== candidate) {
    throw new Error(`agent record path escapes session directory: ${candidate}`);
  }
}
