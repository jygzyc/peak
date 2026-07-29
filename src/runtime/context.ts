import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeProjectLogsDirectory } from "../config/paths.js";
import { toJson } from "../graph/export.js";

export type Phase = "plan" | "supervise" | "execute" | "finalize";
let lastTime = 0;

export function writeGraphContext(projectDir: string, phase: Phase, value: unknown): string {
  const logs = initializeProjectLogsDirectory(projectDir);
  const path = join(logs, `graph-${monotonicTimestamp()}-${phase}.json`);
  const temporary = join(logs, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, toJson(value), { flag: "wx" });
  renameSync(temporary, path);
  return path;
}

function monotonicTimestamp(): string {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return new Date(lastTime).toISOString().replace(/[-:.]/g, "");
}
