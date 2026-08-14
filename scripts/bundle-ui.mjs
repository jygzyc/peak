#!/usr/bin/env node
/**
 * Bundle the Lit-based UI written in TypeScript into the single static
 * script that the HTML shells load. Runs before embed-assets.mjs so the
 * bundled output is embedded into the binary like any other UI asset.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = join(root, "src", "ui", "app", "app.ts");
const outDir = join(root, "src", "ui", "scripts");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: join(outDir, "app.js"),
  minify: true,
  legalComments: "none",
  logLevel: "info",
});

process.stdout.write(`[bundle-ui] built src/ui/scripts/app.js\n`);
