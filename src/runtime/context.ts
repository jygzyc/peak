import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toYaml } from "../graph/export.js";

export type Phase = "plan" | "supervise" | "execute" | "finalize";
let lastTime = 0;

export function writeGraphContext(projectDir: string, phase: Phase, value: unknown): string {
  const logs = join(projectDir, "logs");
  mkdirSync(logs, { recursive: true });
  const path = join(logs, `graph-${monotonicTimestamp()}-${phase}.yaml`);
  const temporary = join(logs, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, toYaml(value), { flag: "wx" });
  renameSync(temporary, path);
  return path;
}

function monotonicTimestamp(): string {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return new Date(lastTime).toISOString().replace(/[-:.]/g, "");
}
