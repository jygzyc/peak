import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ServerProcessMode = "serve";

export interface ServerProcessStatus {
  running: boolean;
  pid: number | null;
  mode: ServerProcessMode | null;
  webUrl: string | null;
  startedAt: string | null;
  boardDir: string | null;
}

interface ServerProcessMetadata {
  pid: number;
  mode: ServerProcessMode;
  webUrl: string | null;
  startedAt: string;
  boardDir: string | null;
}

/** Process-level control files for the one Peak server owned by a Peak home. */
function serverPidPath(peakHome: string): string { return join(peakHome, "server.pid"); }
function serverMetadataPath(peakHome: string): string { return join(peakHome, "server.json"); }
export function serverLogPath(peakHome: string): string { return join(peakHome, "server.log"); }

export function registerServerProcess(
  peakHome: string,
  boardDir?: string,
): () => void {
  const pidPath = serverPidPath(peakHome);
  const existing = readServerPid(pidPath);
  if (existing !== undefined && isProcessAlive(existing)) {
    throw new Error(`Peak server is already running (pid ${existing})`);
  }
  cleanupFiles(peakHome);
  writeFileSync(pidPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  writeMetadata(peakHome, {
    pid: process.pid,
    mode: "serve",
    webUrl: null,
    startedAt: new Date().toISOString(),
    boardDir: boardDir ?? null,
  });
  return () => {
    if (readServerPid(pidPath) === process.pid) cleanupFiles(peakHome);
  };
}

export function publishServerUrl(peakHome: string, webUrl: string): void {
  const metadata = readMetadata(peakHome);
  if (!metadata || metadata.pid !== process.pid) throw new Error("Peak server process is not registered");
  writeMetadata(peakHome, { ...metadata, webUrl });
}

export function getServerProcessStatus(peakHome: string): ServerProcessStatus {
  const pid = readServerPid(serverPidPath(peakHome));
  if (pid === undefined) return stoppedStatus();
  if (!isProcessAlive(pid)) {
    cleanupFiles(peakHome);
    return stoppedStatus();
  }
  const metadata = readMetadata(peakHome);
  return {
    running: true,
    pid,
    mode: metadata?.pid === pid ? metadata.mode : null,
    webUrl: metadata?.pid === pid ? metadata.webUrl : null,
    startedAt: metadata?.pid === pid ? metadata.startedAt : null,
    boardDir: metadata?.pid === pid ? metadata.boardDir : null,
  };
}

export async function stopServerProcess(peakHome: string): Promise<number> {
  const pid = readServerPid(serverPidPath(peakHome));
  if (pid === undefined) throw new Error("no Peak server is registered");
  if (!isProcessAlive(pid)) {
    cleanupFiles(peakHome);
    throw new Error(`Peak server is not running (stale pid ${pid})`);
  }
  await terminateProcess(pid);
  cleanupFiles(peakHome);
  return pid;
}

/** Stops one local process (on Windows, its whole tree) and waits up to 5 seconds for it to exit. */
export async function terminateProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    // SIGTERM maps to TerminateProcess on Windows: no signal handler runs, so
    // the process cannot clean up its own Worker subprocesses. Kill the whole
    // tree instead, or orphaned Workers keep Project directories locked.
    try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
    catch { /* exited */ }
  } else {
    try { process.kill(pid, "SIGTERM"); } catch { /* exited */ }
  }
  for (let attempt = 0; attempt < 100 && isProcessAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (isProcessAlive(pid)) throw new Error(`process did not stop within 5 seconds (pid ${pid})`);
}

function stoppedStatus(): ServerProcessStatus {
  return { running: false, pid: null, mode: null, webUrl: null, startedAt: null, boardDir: null };
}

function writeMetadata(peakHome: string, metadata: ServerProcessMetadata): void {
  const path = serverMetadataPath(peakHome);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function readMetadata(peakHome: string): ServerProcessMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(serverMetadataPath(peakHome), "utf8")) as Partial<ServerProcessMetadata>;
    if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0) return undefined;
    if (value.mode !== "serve") return undefined;
    if (value.webUrl !== null && typeof value.webUrl !== "string") return undefined;
    if (typeof value.startedAt !== "string") return undefined;
    if (value.boardDir !== null && typeof value.boardDir !== "string") return undefined;
    return value as ServerProcessMetadata;
  } catch { return undefined; }
}

function readServerPid(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function cleanupFiles(peakHome: string): void {
  for (const path of [serverPidPath(peakHome), serverMetadataPath(peakHome)]) {
    if (!existsSync(path)) continue;
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
