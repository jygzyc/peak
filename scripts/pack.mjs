/**
 * Production packaging for @jygzyc/peak.
 *
 * Pipeline:
 *   1. `tsc --noEmit` for type checking (fail fast on type errors).
 *   2. Clean dist/ and bundle src/cli.ts with esbuild into a single
 *      minified, mangled ESM file. Runtime npm dependencies and node:*
 *      builtins stay external so consumers' node_modules satisfy them.
 *   3. Verify the declared npm binary boots: `node dist/cli.js workers`
 *      must print valid JSON.
 *   4. Generate the self-contained publishable package inside dist/ (its own
 *      package.json, README.md, LICENSE, version) — only the compiled result
 *      is ever published; the repo root is never packed.
 *   5. `npm pack ./dist` into dist-packages/.
 *   6. Emit dist-packages/manifest.json with name, version, fileName,
 *      compressed size, unpacked size, sha256, and bundle metadata.
 *
 * No sourcemap is emitted — performance over debuggability.
 *
 * `prepare` builds and verifies dist/ for the npm prepack lifecycle.
 * `archive` packs that prepared output into dist-packages/.
 * `binary` compiles a single-file bun binary for the host platform into
 * dist-packages/ (additional artifact; not part of the npm publish flow).
 * With no mode, both phases run. Idempotent. Runnable via `npm run pack`.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// fileURLToPath (not URL.pathname) so the repo root resolves correctly on
// Windows — pathname yields a malformed "\\E:\\Code\\" drive path there.
const root = fileURLToPath(new URL("..", import.meta.url));
const srcEntry = join(root, "src", "cli.ts");
const distDir = join(root, "dist");
const distEntryRelative = "dist/cli.js";
const distEntry = join(root, ...distEntryRelative.split("/"));
const outDir = join(root, "dist-packages");
const npmCache = mkdtempSync(join(tmpdir(), "peak-npm-cache-"));
const mode = process.argv[2] ?? "all";

if (!new Set(["all", "prepare", "archive", "binary"]).has(mode)) {
  process.stderr.write(`unknown pack mode: ${mode}\n`);
  process.exit(2);
}

const doPrepare = mode === "all" || mode === "prepare";
const doArchive = mode === "all" || mode === "archive";
const doBinary = mode === "binary";
let binaryPath = "";

const EXTERNAL = [
  "commander",
  "tar",
];

try {
  if (doPrepare) await step("check scripts", () => {
    const result = spawnSync(process.execPath, [join(root, "scripts", "check-scripts.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  });

  if (doPrepare || doBinary) await step("embed assets", () => {
    // src references the generated file; it must be generated before typecheck / bun compile.
    const result = spawnSync(process.execPath, [join(root, "scripts", "embed-assets.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  });

  if (doPrepare) await step("typecheck", () => {
    const npm = npmInvocation(["run", "typecheck"]);
    const result = spawnSync(npm.command, npm.args, {
      cwd: root,
      stdio: "inherit",
      env: npmEnv(),
      shell: false,
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  });

  if (doPrepare) await step("clean dist", () => {
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
  });

  if (doPrepare) await step("copy runtime assets", () => {
    mkdirSync(join(distDir, "ui"), { recursive: true });
    for (const name of ["dashboard.html", "preview.html", "tasks.html"]) {
      copyFileSync(join(root, "src", "ui", name), join(distDir, "ui", name));
    }
    cpDirectory(join(root, "src", "runtime", "prompts"), join(distDir, "runtime", "prompts"));
  });

  if (doPrepare) await step("esbuild bundle", async () => {
    await build({
      entryPoints: [srcEntry],
      outfile: distEntry,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: EXTERNAL,
      minify: true,
      mangleProps: /^_/,
      legalComments: "none",
      treeShaking: true,
      keepNames: true,
      logLevel: "info",
      absWorkingDir: root,
    });
    try {
      chmodSync(distEntry, 0o755);
    } catch {
      // Best-effort; npm re-applies permissions on install.
    }
  });

  if (doPrepare) await step("verify bundle", () => {
    if (!existsSync(distEntry)) {
      process.stderr.write(`bundle did not produce ${distEntry}\n`);
      process.exit(1);
    }
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    if (packageJson.bin?.peak !== distEntryRelative) {
      process.stderr.write(
        `package bin.peak must reference the bundle: expected ${distEntryRelative}, got ${packageJson.bin?.peak}\n`,
      );
      process.exit(1);
    }
    const verify = spawnSync(process.execPath, [distEntry, "workers"], {
      cwd: root,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
      env: npmEnv(),
    });
    if (verify.status !== 0) {
      process.stderr.write(`bundle verification failed: \`node ${distEntryRelative} workers\` exited non-zero\n`);
      process.stderr.write(verify.stderr || verify.stdout);
      process.exit(verify.status ?? 1);
    }
    try {
      const parsed = JSON.parse(verify.stdout);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("workers output is not a JSON object");
      }
    } catch (err) {
      process.stderr.write(`bundle verification: workers output is not valid JSON: ${err.message}\n`);
      process.exit(1);
    }
  });

  if (doPrepare) await step("dist package", () => {
    // Only the compiled result is published: dist/ becomes a self-contained
    // package with its own manifest (name/version/bin/deps), README, LICENSE
    // and the version file (`src/cli.ts` resolves `version` next to the
    // bundle when `<moduleDir>/../version` is absent). The repo root —
    // sources, docs, tests — is never packed.
    const fileVersion = readFileSync(join(root, "version"), "utf8").trim();
    const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    const distPkg = {
      name: rootPkg.name,
      version: fileVersion,
      description: rootPkg.description,
      type: "module",
      bin: { peak: "cli.js" },
      dependencies: rootPkg.dependencies,
      engines: rootPkg.engines,
      license: rootPkg.license,
      repository: rootPkg.repository,
      publishConfig: rootPkg.publishConfig,
    };
    writeFileSync(join(distDir, "package.json"), `${JSON.stringify(distPkg, null, 2)}\n`);
    for (const name of ["README.md", "LICENSE", "version"]) {
      copyFileSync(join(root, name), join(distDir, name));
    }
  });

  if (doArchive) await step("sync version", () => {
    // The version file is the single source of truth; npm pack reads package.json, so sync it first.
    const fileVersion = readFileSync(join(root, "version"), "utf8").trim();
    const packageJsonPath = join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (packageJson.version !== fileVersion) {
      packageJson.version = fileVersion;
      writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
      process.stdout.write(`[pack] version synced to ${fileVersion}\n`);
    }
  });

  if (doArchive) await step("npm pack", () => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const npm = npmInvocation(
      // Pack only the self-contained dist package, never the repo root.
      // --ignore-scripts: skip the prepack lifecycle hook here, because THIS
      // script IS the prepack step. Without it, prepack → pack.mjs → npm pack
      // → prepack would recurse infinitely once a "prepack" script is declared.
      ["pack", "./dist", "--pack-destination", outDir, "--ignore-scripts", "--json"],
    );
    const packed = spawnSync(
      npm.command,
      npm.args,
      {
        cwd: root,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 10,
        env: npmEnv(),
        shell: false,
      },
    );

    if (packed.status !== 0) {
      process.stderr.write(packed.stderr || packed.stdout);
      process.exit(packed.status ?? 1);
    }

    const [entry] = JSON.parse(packed.stdout);
    const fileName = entry.filename;
    const packedFiles = new Set(
      (entry.files ?? []).map((file) => String(file.path).replaceAll("\\", "/")),
    );
    const forbidden = [...packedFiles].find(
      (path) => /^(examples|docs|src)(\/|$)/.test(path) || path === "AGENTS.md" || path === "RELEASE.md",
    );
    if (forbidden) {
      process.stderr.write(`npm package must contain only the compiled dist package, found: ${forbidden}\n`);
      process.exit(1);
    }
    for (const requiredPath of ["cli.js", "package.json", "version"]) {
      if (!packedFiles.has(requiredPath)) {
        process.stderr.write(`npm package is missing ${requiredPath}\n`);
        process.exit(1);
      }
    }
    // npm usually honors --pack-destination, but in some lifecycle wrappers
    // (e.g. publish --dry-run) it may write to cwd instead. Check both.
    const tarball = [join(outDir, fileName), join(root, fileName)].find(existsSync);

    if (!tarball) {
      process.stderr.write(`expected compressed package at ${join(outDir, fileName)} (or ${join(root, fileName)})\n`);
      process.exit(1);
    }

    const bytes = readFileSync(tarball);
    const bundleBytes = statSync(distEntry).size;
    const manifest = {
      name: entry.name,
      version: entry.version, // In sync with the version file (package.json is synced before npm pack)
      fileName,
      size: bytes.length,
      unpackedSize: entry.unpackedSize,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bundle: {
        entry: "src/cli.ts",
        output: "cli.js", // At the package root (the dist package is itself the package root)
        bundleBytes,
        external: EXTERNAL,
        format: "esm",
        platform: "node",
        target: "node22",
        minify: true,
        mangleProps: "^_",
        keepNames: true,
      },
    };

    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  });

  // Binary mode is an additional artifact: bun compiles a single-file binary for the host platform; the npm publish flow (all) is unchanged.
  if (doBinary) await step("check bun", () => {
    const result = spawnSync("bun", ["--version"], { cwd: root, encoding: "utf-8" });
    if (result.error || result.status !== 0) {
      process.stderr.write("binary mode requires bun on PATH (https://bun.sh), but `bun --version` failed\n");
      process.exit(1);
    }
  });

  if (doBinary) await step("bun compile", () => {
    mkdirSync(outDir, { recursive: true });
    const fileVersion = readFileSync(join(root, "version"), "utf8").trim();
    const binaryName = `peak-${fileVersion}-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
    binaryPath = join(outDir, binaryName);
    // commander/tar are bundled into the binary by bun from node_modules; assets are already embedded at build time.
    const result = spawnSync("bun", ["build", srcEntry, "--compile", "--outfile", binaryPath], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  });

  if (doBinary) await step("verify binary", () => {
    if (!existsSync(binaryPath)) {
      process.stderr.write(`bun compile did not produce ${binaryPath}\n`);
      process.exit(1);
    }
    const workers = spawnSync(binaryPath, ["workers"], {
      cwd: root,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
    });
    if (workers.status !== 0) {
      process.stderr.write(`binary verification failed: \`${binaryPath} workers\` exited non-zero\n`);
      process.stderr.write(workers.stderr || workers.stdout);
      process.exit(workers.status ?? 1);
    }
    try {
      const parsed = JSON.parse(workers.stdout);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("workers output is not a JSON object");
      }
    } catch (err) {
      process.stderr.write(`binary verification: workers output is not valid JSON: ${err.message}\n`);
      process.exit(1);
    }
    const fileVersion = readFileSync(join(root, "version"), "utf8").trim();
    const versionOutput = spawnSync(binaryPath, ["--version"], { cwd: root, encoding: "utf-8" });
    if (versionOutput.status !== 0 || versionOutput.stdout.trim() !== fileVersion) {
      process.stderr.write(
        `binary verification: --version output ${JSON.stringify(versionOutput.stdout?.trim())} does not match version file ${fileVersion}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`[pack] binary verified: ${binaryPath}\n`);
  });
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}

function cpDirectory(source, target) {
  mkdirSync(target, { recursive: true });
  for (const name of ["plan.md", "supervise.md", "execute.md", "execute-finalize.md"]) {
    copyFileSync(join(source, name), join(target, name));
  }
}

async function step(name, fn) {
  process.stdout.write(`[pack] ${name}...\n`);
  await fn();
}

function npmEnv() {
  // npm_config_dry_run="" forces the inner `npm pack` to actually write the
  // tarball even when the outer command was `npm publish --dry-run` (which
  // propagates dry-run into prepack's env and would make the inner pack a
  // no-op, leaving no tarball to verify).
  return { ...process.env, npm_config_cache: npmCache, npm_config_dry_run: "" };
}

function npmInvocation(args) {
  const fromLifecycle = process.env.npm_execpath;
  if (fromLifecycle && existsSync(fromLifecycle)) {
    return { command: process.execPath, args: [fromLifecycle, ...args] };
  }
  if (process.platform === "win32") {
    const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(bundled)) {
      return { command: process.execPath, args: [bundled, ...args] };
    }
    throw new Error("npm CLI path not found; run this script through `npm run pack`");
  }
  return { command: "npm", args };
}
