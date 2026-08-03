import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeProjectLogsDirectory } from "../config/paths.js";
import { localTimestamp } from "../graph/api.js";
import { toJson } from "../graph/export.js";

export type Phase = "plan" | "supervise" | "execute" | "finalize";
export function writeGraphContext(projectDir: string, phase: Phase, executionId: string, value: unknown): string {
  const logs = initializeProjectLogsDirectory(projectDir);
  const path = join(logs, `graph-${localTimestamp()}-${executionId}-${phase}.json`);
  const temporary = join(logs, `.${executionId}-${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(temporary, toJson(value), { flag: "wx" });
  renameSync(temporary, path);
  return path;
}
