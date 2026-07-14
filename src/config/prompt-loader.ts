/**
 * Prompt loader — assembles a subagent prompt from a PromptSpec.
 *
 * Reads the role preamble from `prompt.file` (required, relative to the task
 * config dir). Appends optional `rules`, `knowledge`, and `instructions`
 * files/text in order. The dynamic graph context is prepended separately by
 * ContextBuilder; this loader only produces the static role preamble.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptSpec } from "../agent/types.js";

export interface ResolvedPrompt {
  preamble: string;
  fromConfig: boolean;
}

export interface PromptLoaderOptions {
  baseDir?: string;
}

/**
 * The package root (dist/) — derived from this compiled module's location so
 * that builtin prompt paths like "agent/prompts/planner.md" resolve to
 * dist/agent/prompts/ regardless of cwd.
 *
 * Two layouts must work:
 *   - tsc dev output: prompt-loader.js lives at dist/config/prompt-loader.js,
 *     so the dist root is one level up (dist/).
 *   - esbuild single-file bundle (npm run pack): everything is inlined into
 *     dist/index.js, so the module dir IS dist/ already. Probing for the
 *     prompts dir lets us pick the right ancestor in both cases.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = resolveBuiltinRoot(MODULE_DIR);

function resolveBuiltinRoot(moduleDir: string): string {
  // dist/config/  -> dist/  (tsc dev layout)
  // dist/         -> dist/  (flat esbuild bundle; prompts copied alongside)
  for (const candidate of [resolve(moduleDir, ".."), moduleDir]) {
    if (existsSync(join(candidate, "agent", "prompts", "planner.md"))) {
      return candidate;
    }
  }
  // Fallback: assume the tsc layout (parent of the module dir).
  return resolve(moduleDir, "..");
}

export class PromptLoader {
  constructor(private readonly options: PromptLoaderOptions = {}) {}

  load(spec: PromptSpec): ResolvedPrompt {
    const parts: string[] = [];

    const primary = this.tryReadFile(spec.file);
    if (!primary) {
      return { preamble: "", fromConfig: false };
    }
    parts.push(primary);

    if (spec.rules) {
      for (const rule of spec.rules) {
        const text = this.tryReadFile(rule) ?? rule;
        if (text) parts.push("---\n" + text);
      }
    }

    if (spec.knowledge) {
      for (const k of spec.knowledge) {
        const text = this.tryReadFile(k) ?? k;
        if (text) parts.push("---\n" + text);
      }
    }

    if (spec.instructions) {
      parts.push("---\nInstructions: " + spec.instructions);
    }

    return { preamble: parts.join("\n\n"), fromConfig: true };
  }

  private tryReadFile(pathOrText: string): string | undefined {
    if (!pathOrText) return undefined;
    if (looksLikePath(pathOrText)) {
      const abs = this.resolvePath(pathOrText);
      if (existsSync(abs)) {
        return readFileSync(abs, "utf-8");
      }
    }
    return undefined;
  }

  private resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.options.baseDir ?? DIST_ROOT, p);
  }
}

function looksLikePath(s: string): boolean {
  return /[\\/]/.test(s) || /\.[a-z0-9]+$/i.test(s) || s.startsWith(".") || s.startsWith("~/");
}
