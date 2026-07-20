/**
 * Production packaging for @jygzyc/peak.
 *
 * Pipeline:
 *   1. `tsc --noEmit` for type checking (fail fast on type errors).
 *   2. Clean dist/ and bundle src/cli.ts with esbuild into a single
 *      minified, mangled ESM file. The four npm dependencies
 *      (commander) and node:* builtins
 *      stay external so consumers' node_modules satisfy them.
 *   3. Verify the declared npm binary boots: `node dist/cli.js workers`
 *      must print valid JSON.
 *   4. `npm pack` the bundled dist into dist-packages/.
 *   5. Emit dist-packages/manifest.json with name, version, fileName,
 *      compressed size, unpacked size, sha256, and bundle metadata.
 *
 * No sourcemap is emitted — performance over debuggability.
 *
 * `prepare` builds and verifies dist/ for the npm prepack lifecycle.
 * `archive` packs that prepared output into dist-packages/.
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

if (!new Set(["all", "prepare", "archive"]).has(mode)) {
  process.stderr.write(`unknown pack mode: ${mode}\n`);
  process.exit(2);
}

const EXTERNAL = [
  "commander",
];

try {
  if (mode !== "archive") await step("typecheck", () => {
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

  if (mode !== "archive") await step("clean dist", () => {
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
  });

  if (mode !== "archive") await step("copy dashboard.html", () => {
    copyFileSync(join(root, "src", "server", "dashboard.html"), join(distDir, "dashboard.html"));
  });

  if (mode !== "archive") await step("esbuild bundle", async () => {
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

  if (mode !== "archive") await step("verify bundle", () => {
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

  if (mode !== "prepare") await step("npm pack", () => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const npm = npmInvocation(
      // --ignore-scripts: skip the prepack lifecycle hook here, because THIS
      // script IS the prepack step. Without it, prepack → pack.mjs → npm pack
      // → prepack would recurse infinitely once a "prepack" script is declared.
      ["pack", "--pack-destination", outDir, "--ignore-scripts", "--json"],
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
    if (!packedFiles.has(distEntryRelative)) {
      process.stderr.write(`npm package does not contain declared binary ${distEntryRelative}\n`);
      process.exit(1);
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
      version: entry.version,
      fileName,
      size: bytes.length,
      unpackedSize: entry.unpackedSize,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bundle: {
        entry: "src/cli.ts",
        output: distEntryRelative,
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
} finally {
  rmSync(npmCache, { recursive: true, force: true });
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
