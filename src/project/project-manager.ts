import { join, resolve } from "node:path";
import type { CreateProjectInput, ProjectMeta } from "../graph/types.js";
import { GraphClient } from "../graph/graph-client.js";

export class ProjectManager {
  constructor(readonly projectsDir: string, private readonly graph: GraphClient) {}
  create(input: CreateProjectInput): Promise<ProjectMeta> { return this.graph.createProject(input); }
  delete(projectId: string): Promise<void> { return this.graph.deleteProject(projectId); }
  projectDir(projectId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
      throw new Error("invalid project id");
    }
    return join(resolve(this.projectsDir), projectId);
  }
}
