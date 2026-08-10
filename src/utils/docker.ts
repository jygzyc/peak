import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { GraphClient } from "../graph/graph-client.js";
import { WORKER_REGISTRY } from "../worker/registry.js";
import { sourceTitle } from "./helpers.js";
import { initializePeakPaths, projectDir, projectTmpDir, resolveTaskSkillSource } from "./paths.js";
import { deregisterRuntime, listProjectRegistrations } from "./project-registry.js";
import { getServerProcessStatus } from "./server-process.js";
import { loadTaskConfig, persistProjectId } from "./task-config.js";
import type { ResolvedTaskConfig } from "./types.js";

/**
 * Docker/Podman CLI primitives for the per-task container deployment. Every
 * container invocation the user would otherwise type by hand is generated
 * here; failures are reported as Peak errors with a local-mode fallback hint,
 * never as raw docker/podman output. Peak only USES the task image — building
 * it is out of scope for this repository.
 */

let probedCli: string | undefined;

/**
 * The container CLI Peak shells out to: `PEAK_CONTAINER_RUNTIME` forces one
 * binary (docker, podman, or a full path); otherwise docker is preferred and
 * podman the fallback (both expose the same CLI surface; podman >= 4 is
 * required for `--add-host ...:host-gateway`). The probe result is cached.
 */
export function containerCli(): string {
  const override = process.env.PEAK_CONTAINER_RUNTIME?.trim();
  if (override) return override;
  if (probedCli === undefined) {
    probedCli = ["docker", "podman"].find((candidate) => {
      const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
      return !probe.error && probe.status === 0;
    }) ?? "docker";
  }
  return probedCli;
}

/** Verifies the container CLI exists and its engine is reachable; throws a readable error otherwise. */
export function requireDocker(): void {
  const cli = containerCli();
  const result = spawnSync(cli, ["info"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${cli} CLI or its engine is not available; install/start Docker or Podman (or set PEAK_CONTAINER_RUNTIME), `
      + "or run the task in local mode (drop --docker)",
    );
  }
}

/** Deterministic per-task container name: `peak_<sha256(taskName)[0:6]>`. */
export function taskContainerName(taskName: string): string {
  return `peak_${createHash("sha256").update(taskName, "utf8").digest("hex").slice(0, 6)}`;
}

/** The shared task image tag for one Peak version. */
export function peakTaskImage(version: string): string {
  return `peak-task:${version}`;
}

/**
 * The registry tag of the published task image. The image is built and
 * published outside this repository; regular runs only pull it.
 * `PEAK_IMAGE_REPO` overrides the repository (private registries, mirrors).
 */
export function remoteTaskImage(version: string): string {
  const repo = process.env.PEAK_IMAGE_REPO ?? "jygzyc/peak-task";
  return `${repo}:${version}`;
}

export function dockerImageExists(image: string): boolean {
  return spawnSync(containerCli(), ["image", "inspect", image], { stdio: "ignore" }).status === 0;
}

/** Pulls an image; returns false (rather than throwing) so callers can fall back to local mode. */
export function dockerPull(image: string): boolean {
  const result = spawnSync(containerCli(), ["pull", image], { stdio: "inherit" });
  return !result.error && result.status === 0;
}

/**
 * The task image is unavailable locally and could not be pulled.
 * `peak start --docker` catches this and falls back to local mode instead of
 * failing the task.
 */
export class DockerImageUnavailableError extends Error {
  readonly image: string;
  constructor(image: string) {
    super(`task image ${image} is unavailable (not present locally, pull failed); run without --docker`);
    this.name = "DockerImageUnavailableError";
    this.image = image;
  }
}

/**
 * Resolves the task image for one Peak version: a locally present tag wins
 * (externally built/loaded images), otherwise the published registry tag is
 * pulled. Throws DockerImageUnavailableError when neither works.
 */
export function resolveTaskImage(version: string): string {
  const local = peakTaskImage(version);
  if (dockerImageExists(local)) return local;
  const remote = remoteTaskImage(version);
  process.stdout.write(`[peak] image ${local} missing; pulling ${remote}\n`);
  if (dockerPull(remote)) return remote;
  throw new DockerImageUnavailableError(local);
}

export type DockerContainerState = "running" | "exited" | "missing";

export function dockerContainerState(name: string): DockerContainerState {
  const result = spawnSync(containerCli(), ["inspect", "-f", "{{.State.Status}}", name], { encoding: "utf8" });
  if (result.status !== 0) return "missing";
  return result.stdout.trim() === "running" ? "running" : "exited";
}

export interface DockerTaskSpec {
  name: string;
  image: string;
  /** Absolute host path of each Project UUID directory, mounted at the same UUID under /peak/projects. */
  projectIds: string[];
  projectsRoot: string;
  boardDir: string;
  graphUrl: string;
  /** `[hostPath, containerPath]` login-state mounts (read-only), only when the host path exists. */
  credentialMounts: Array<[string, string]>;
  /** Board-local Skill mounts used when no matching host-global Skill exists. */
  skillMounts: Array<[string, string]>;
  preflightBackends: string[];
}

/** Rewrites a loopback serve URL for container reachability via the host gateway. */
export function containerGraphUrl(graphUrl: string): string {
  const url = new URL(graphUrl);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") {
    url.hostname = "host.docker.internal";
  }
  return url.toString().replace(/\/$/, "");
}

/** Assembles the full `docker run` argv for one task container. */
export function dockerRunArgs(spec: DockerTaskSpec): string[] {
  const args = ["run", "-d", "--rm", "--read-only", "--name", spec.name];
  for (const projectId of spec.projectIds) {
    const hostProject = join_(spec.projectsRoot, projectId);
    args.push("-v", `${hostProject}:/peak/projects/${projectId}:ro`);
    args.push("-v", `${join_(hostProject, ".tmp")}:/peak/projects/${projectId}/.tmp:rw`);
  }
  args.push("-v", `${spec.boardDir}:/board:ro`);
  for (const [host, target] of spec.credentialMounts) args.push("-v", `${host}:${target}:ro`);
  for (const [host, target] of spec.skillMounts) args.push("-v", `${host}:${target}:ro`);
  if (spec.preflightBackends.length > 0) args.push("-e", `PEAK_PREFLIGHT_BACKENDS=${spec.preflightBackends.join(",")}`);
  args.push("--add-host", "host.docker.internal:host-gateway");
  args.push(spec.image);
  const command = [
    "start", "/board", "--foreground", "--attach-only",
    "--graph-url", containerGraphUrl(spec.graphUrl),
    "--projects-root", "/peak/projects",
    "--no-install-skills",
  ];
  return [...args, ...command];
}

/** Path join that keeps POSIX separators valid for the container side. */
function join_(root: string, child: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${child}`;
}

/** Starts one task container detached; returns the docker-assigned container id. */
export function dockerRunDetached(spec: DockerTaskSpec): string {
  const result = spawnSync(containerCli(), dockerRunArgs(spec), { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`docker run failed: ${(result.stderr || result.error?.message || "").trim()}; `
      + "run the task in local mode (drop --docker) as a fallback");
  }
  return result.stdout.trim();
}

export function dockerStop(name: string): void {
  const result = spawnSync(containerCli(), ["stop", name], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`docker stop failed for ${name}: ${(result.stderr || "").trim()}`);
  }
}

/** Recent container logs, for diagnosing an early exit. */
export function dockerLogs(name: string, tail = 50): string {
  const result = spawnSync(containerCli(), ["logs", "--tail", String(tail), name], { encoding: "utf8" });
  return `${result.stdout}${result.stderr}`.trim();
}

export interface DockerTaskOptions {
  peakHome?: string;
  graphUrl?: string;
  version: string;
}

/** Host login-state directories mounted read-only when present (see container/AUTH.md). */
const CREDENTIAL_MOUNTS: Array<[string, string]> = [
  [join(homedir(), ".claude"), "/root/.claude"], // also covers ~/.claude/skills
  [join(homedir(), ".codex"), "/root/.codex"],
  [join(homedir(), ".local", "share", "opencode"), "/root/.local/share/opencode"],
  [join(homedir(), ".pi"), "/root/.pi"],
  // Global Skills stay live from the host instead of a stale image snapshot.
  [join(homedir(), ".agents", "skills"), "/root/.agents/skills"],
];

const SKILL_DIRECTORIES = {
  agents: {
    host: join(homedir(), ".agents", "skills"),
    container: "/root/.agents/skills",
  },
  claude: {
    host: join(homedir(), ".claude", "skills"),
    container: "/root/.claude/skills",
  },
} as const;

/**
 * Keeps the container read-only without losing Board-local Skills. Existing
 * host-global Skills arrive through the read-only credential mounts; only a
 * missing Skill is overlaid directly from the read-only Board mount.
 */
export function dockerSkillMounts(config: ResolvedTaskConfig): Array<[string, string]> {
  const directories = new Set(Object.values(config.workers)
    .flatMap((worker) => WORKER_REGISTRY[worker.type].skillDirectories));
  const mounts: Array<[string, string]> = [];
  for (const name of config.board.skills) {
    for (const directory of directories) {
      const paths = SKILL_DIRECTORIES[directory];
      if (existsSync(join(paths.host, name, "SKILL.md"))) continue;
      const source = resolveTaskSkillSource(config.taskDir, name);
      if (!existsSync(join(source, "SKILL.md"))) {
        throw new Error(`configured Skill is not globally installed and Board-local Skill is missing: ${name}`);
      }
      mounts.push([source, `${paths.container}/${name}`]);
    }
  }
  return mounts;
}

/**
 * Host side of `peak start --docker`: phase one initializes/attaches every
 * Project UUID through the serve Graph API and registers the task in the
 * Server-authoritative registry; phase two launches one per-task container
 * with exactly those UUID directories mounted. The user never types a docker
 * command.
 */
export async function launchDockerTask(taskDirectory: string, options: DockerTaskOptions): Promise<string> {
  requireDocker();
  const config = loadTaskConfig(taskDirectory);
  const paths = initializePeakPaths(options.peakHome);
  const graphUrl = options.graphUrl ?? getServerProcessStatus(paths.peakHome).webUrl;
  if (!graphUrl) throw new Error("no running Peak serve found; start `peak serve` first or pass --graph-url");

  // Resolve the image BEFORE any Project creation/registration so an
  // unavailable image leaves no side effects behind when the CLI falls back.
  const image = resolveTaskImage(options.version);

  const client = new GraphClient(graphUrl);

  // Phase one: UUIDs exist before the container so mounts are exact.
  const projectIds: string[] = [];
  for (let index = 0; index < config.board.projects.length; index += 1) {
    const project = config.board.projects[index]!;
    if (project.id) {
      await client.getProject(project.id);
      projectIds.push(project.id);
      continue;
    }
    const created = await client.createProject({ title: sourceTitle(project.source), target: project.source, goal: project.goal });
    persistProjectId(config, index, created.id);
    projectIds.push(created.id);
  }
  for (const projectId of projectIds) mkdirSync(projectTmpDir(projectDir(paths.projectsDir, projectId)), { recursive: true });

  const taskName = config.board.name ?? basename(config.taskDir);
  const container = taskContainerName(taskName);
  pruneStaleContainerEntries(paths.peakHome, container);
  const runtimeId = randomBytes(4).toString("hex");
  const deregister = async (): Promise<void> => {
    for (const projectId of projectIds) await client.deregisterProject(projectId, runtimeId).catch(() => undefined);
  };
  try {
    for (const projectId of projectIds) {
      await client.registerProject(projectId, {
        taskName, boardDir: config.taskDir, mode: "start", runtimeId, container, graphUrl,
      });
    }
  } catch (error) {
    await deregister();
    throw error;
  }

  try {
    dockerRunDetached({
      name: container,
      image,
      projectIds,
      projectsRoot: paths.projectsDir,
      boardDir: config.taskDir,
      graphUrl,
      credentialMounts: CREDENTIAL_MOUNTS.filter(([host]) => existsSync(host)),
      skillMounts: dockerSkillMounts(config),
      preflightBackends: [...new Set(Object.values(config.workers).map((worker) => worker.type))],
    });
  } catch (error) {
    await deregister();
    throw error;
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = dockerContainerState(container);
    if (state === "running") {
      process.stdout.write([
        `[peak] task: running (container ${container})`,
        `[peak] container: ${container}`,
        `[peak] projects: ${projectIds.join(", ")}`,
        `[peak] graph: ${graphUrl}`,
        "",
      ].join("\n"));
      return container;
    }
    if (state === "exited") {
      const logs = dockerLogs(container);
      await deregister();
      throw new Error(`task container ${container} exited during startup:\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await deregister();
  throw new Error(`task container ${container} did not reach running state; check docker logs ${container}`);
}

/** Drops registry entries of a container that is no longer running (stale crash leftovers). */
function pruneStaleContainerEntries(peakHome: string, container: string): void {
  const stale = listProjectRegistrations(peakHome).filter((entry) => entry.container === container);
  if (stale.length === 0) return;
  if (dockerContainerState(container) === "running") return; // the 409 conflict path reports this
  for (const runtimeId of new Set(stale.map((entry) => entry.runtimeId))) deregisterRuntime(peakHome, runtimeId);
}
