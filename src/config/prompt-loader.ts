/**
 * Prompt loader — assembles a subagent prompt from a PromptSpec.
 *
 * Resolves the system prompt from a builtin TypeScript registry or an external
 * file, then appends optional rules, knowledge, skills, and instructions.
 * Runtime graph context is owned by ContextBuilder and final composition by
 * PromptBuilder.
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";
import type {
  PromptManifest,
  PromptManifestComponent,
  PromptComponentKind,
  PromptSpec,
} from "../agent/types.js";
import { isBuiltinPromptSource, resolveBuiltinPrompt } from "../agent/prompts/index.js";

export interface ResolvedPrompt {
  preamble: string;
  fromConfig: boolean;
  manifest: PromptManifest;
}

export interface PromptLoaderOptions {
  baseDir?: string;
}

export class PromptLoader {
  constructor(private readonly options: PromptLoaderOptions = {}) {}

  load(spec: PromptSpec, primaryKind: Extract<PromptComponentKind, "primary" | "conclude"> = "primary"): ResolvedPrompt {
    const parts: string[] = [];
    const components: PromptManifestComponent[] = [];

    const primary = this.readPrimaryComponent(spec.file, primaryKind, 0);
    if (!primary || primary.text.length === 0) {
      return { preamble: "", fromConfig: false, manifest: emptyManifest() };
    }
    parts.push(primary.text);
    components.push(primary.component);

    if (spec.rules) {
      for (let index = 0; index < spec.rules.length; index += 1) {
        const source = spec.rules[index]!;
        const item = this.readFileOrInline(source, "rule", index);
        if (item.text) {
          parts.push("---\n" + item.text);
          components.push(item.component);
        }
      }
    }

    if (spec.knowledge) {
      for (let index = 0; index < spec.knowledge.length; index += 1) {
        const source = spec.knowledge[index]!;
        const item = this.readFileOrInline(source, "knowledge", index);
        if (item.text) {
          parts.push("---\n" + item.text);
          components.push(item.component);
        }
      }
    }

    if (spec.skills) {
      for (let index = 0; index < spec.skills.length; index += 1) {
        const source = spec.skills[index]!;
        const item = this.readFileOrInline(source, "skill", index);
        if (item.text) {
          parts.push("---\n" + item.text);
          components.push(item.component);
        }
      }
    }

    if (spec.instructions) {
      const text = normalizeText(spec.instructions);
      parts.push("---\nInstructions: " + text);
      components.push(componentFor("instructions", 0, "inline:instructions", text));
    }

    const preamble = parts.join("\n\n");
    return {
      preamble,
      fromConfig: true,
      manifest: { version: 1, hash: sha256(preamble), components },
    };
  }

  private readPrimaryComponent(
    source: string,
    kind: Extract<PromptComponentKind, "primary" | "conclude">,
    index: number,
  ): { text: string; component: PromptManifestComponent } | undefined {
    const builtin = resolveBuiltinPrompt(source);
    if (builtin !== undefined) {
      const text = normalizeText(builtin);
      return { text, component: componentFor(kind, index, source, text) };
    }
    if (isBuiltinPromptSource(source)) return undefined;
    return this.readFileComponent(source, kind, index);
  }

  private readFileComponent(
    source: string,
    kind: Extract<PromptComponentKind, "primary" | "conclude">,
    index: number,
  ): { text: string; component: PromptManifestComponent } | undefined {
    if (!source) return undefined;
    const abs = this.resolvePath(source);
    if (!existsSync(abs)) return undefined;
    const text = normalizeText(readFileSync(abs, "utf-8"));
    return { text, component: componentFor(kind, index, source, text, abs) };
  }

  private readFileOrInline(
    source: string,
    kind: Extract<PromptComponentKind, "rule" | "knowledge" | "skill">,
    index: number,
  ): { text: string; component: PromptManifestComponent } {
    if (looksLikePath(source)) {
      const item = this.readFileComponent(source, "primary", index);
      if (!item) throw new Error(`prompt ${kind} file not found: ${this.resolvePath(source)}`);
      return {
        text: item.text,
        component: { ...item.component, kind },
      };
    }
    const text = normalizeText(source);
    return { text, component: componentFor(kind, index, `inline:${kind}[${index}]`, text) };
  }

  private resolvePath(p: string): string {
    const expanded = p.startsWith("~/") || p.startsWith("~\\")
      ? join(homedir(), p.slice(2))
      : p;
    return isAbsolute(expanded) ? expanded : resolve(this.options.baseDir ?? process.cwd(), expanded);
  }
}

/** Resolve only the path-bearing fields declared by a task/agent prompt patch.
 * Inline rule/knowledge text is preserved. This is performed before profile
 * merging so inherited builtin components keep their own package origin. */
export function resolvePromptPaths<T extends Partial<PromptSpec>>(spec: T, baseDir: string): T {
  const out = { ...spec } as Partial<PromptSpec>;
  if (spec.file) out.file = isBuiltinPromptSource(spec.file) ? spec.file : resolve(baseDir, spec.file);
  if (spec.concludeFile) {
    out.concludeFile = isBuiltinPromptSource(spec.concludeFile)
      ? spec.concludeFile
      : resolve(baseDir, spec.concludeFile);
  }
  if (spec.rules) {
    out.rules = spec.rules.map((source) => looksLikePath(source) ? resolve(baseDir, source) : source);
  }
  if (spec.knowledge) {
    out.knowledge = spec.knowledge.map((source) => looksLikePath(source) ? resolve(baseDir, source) : source);
  }
  if (spec.skills) {
    out.skills = spec.skills.map((source) => looksLikePath(source) ? resolve(baseDir, source) : source);
  }
  return out as T;
}

function emptyManifest(): PromptManifest {
  return { version: 1, hash: sha256(""), components: [] };
}

function componentFor(
  kind: PromptComponentKind,
  index: number,
  source: string,
  text: string,
  resolvedPath?: string,
): PromptManifestComponent {
  return {
    kind,
    index,
    source,
    resolvedPath,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function looksLikePath(s: string): boolean {
  // Multi-line knowledge/rules are unambiguously inline prose even when they
  // contain filesystem-like slashes (for example data-flow notation).
  if (/\r|\n/.test(s)) return false;
  return /[\\/]/.test(s) || /\.[a-z0-9]+$/i.test(s) || s.startsWith(".") || s.startsWith("~/");
}
