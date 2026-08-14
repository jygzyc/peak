import { spawnSync } from "node:child_process";

/**
 * Container-CLI primitives shared by the Docker execution backend and the CLI.
 * Peak drives any docker-compatible engine — docker or podman (>= 4, for
 * `--add-host ...:host-gateway`); `PEAK_CONTAINER_RUNTIME` forces a binary.
 * Peak only USES the task image; building/publishing it is out of scope.
 */

let probedCli: string | undefined;

/**
 * The container CLI Peak shells out to: `PEAK_CONTAINER_RUNTIME` forces one
 * binary (docker, podman, or a full path); otherwise docker is preferred and
 * podman the fallback. The probe result is cached.
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
      + "or set task.json execution.mode to local",
    );
  }
}

/** Verifies the resolved image and Task network can create a short-lived container. */
export function requireTaskContainer(image: string, networkMode?: string): void {
  const cli = containerCli();
  const args = ["run", "--rm"];
  if (networkMode) args.push("--network", networkMode);
  args.push(image, "true");
  const result = spawnSync(cli, args, { encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`task container preflight failed: ${(result.stderr || result.error?.message || "unknown error").trim()}`);
  }
}

/** The shared task image tag for one Peak version. */
export function peakTaskImage(version: string): string {
  return `peak-task:${version}`;
}

/** The registry tag of the published task image. `PEAK_IMAGE_REPO` overrides the repository. */
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

/** Pulls the published task image explicitly, unless it is already cached. */
export function pullTaskImage(version: string, force = false): string {
  const image = remoteTaskImage(version);
  if (!force && dockerImageExists(image)) return image;
  process.stdout.write(`[peak] pulling ${image}\n`);
  if (!dockerPull(image)) throw new Error(`failed to pull task image ${image}`);
  return image;
}

/**
 * The task image is unavailable locally and could not be pulled. Task startup
 * catches this and falls the complete Task back to local mode.
 */
export class DockerImageUnavailableError extends Error {
  readonly image: string;
  constructor(image: string) {
    super(`task image ${image} is unavailable (not present locally, pull failed); use task.json execution.mode local`);
    this.name = "DockerImageUnavailableError";
    this.image = image;
  }
}

/**
 * Resolves the task image for one Peak version: a locally built tag wins,
 * then a cached published tag, otherwise the published tag is pulled.
 */
export function resolveTaskImage(version: string): string {
  const local = peakTaskImage(version);
  if (dockerImageExists(local)) return local;
  const remote = remoteTaskImage(version);
  if (dockerImageExists(remote)) return remote;
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

/**
 * Removes a same-named container that is no longer running so a fresh task can
 * claim the deterministic name. A still-running container is left untouched.
 */
export function removeConflictingContainer(name: string): void {
  if (dockerContainerState(name) !== "exited") return;
  const cli = containerCli();
  const result = spawnSync(cli, ["rm", "-f", name], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(`a stopped container named ${name} exists and could not be removed; run \`${cli} rm -f ${name}\` manually`);
  }
}

/** Stops one container by name; used by the CLI/task-manager stop paths. */
export function dockerStop(name: string): void {
  const cli = containerCli();
  const result = spawnSync(cli, ["stop", name], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`${cli} stop failed for ${name}: ${(result.stderr || "").trim()}`);
  }
}
