/**
 * User-defined provider configuration loaded from ~/.peak/providers.json
 * (override path via PEAK_AGENT_PROVIDERS env).
 *
 * Schema mirrors the on-disk JSON structure. Each provider entry is keyed by
 * id and holds baseURL, apiKeyEnv, model, plus optional overrides. The id
 * matches the `worker.provider` field in task.json.
 *
 * Built-in presets (provider-presets.ts) provide defaults for common APIs;
 * users only need to copy a preset into this file and fill in the API key.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { PROVIDER_PRESETS, type ProviderPreset } from "./provider-presets.js";
import { providersFile } from "./peak-home.js";

export interface UserProviderConfig {
  /** API base URL (OpenAI-compatible endpoint). */
  baseURL: string;
  /** Env var name holding the API key. */
  apiKeyEnv: string;
  /** Default model id. */
  model: string;
  /** Optional human-readable label. */
  name?: string;
  /** Optional provider kind: "openai" (default) or "anthropic". */
  kind?: "openai" | "anthropic";
  /** Optional extra fields forwarded to the underlying SDK. */
  headers?: Record<string, string>;
}

export type ProvidersFile = Record<string, UserProviderConfig>;

let cachedFile: ProvidersFile | undefined;
let cachedPath: string | undefined;

export function defaultProvidersPath(): string {
  const fromEnv = process.env.PEAK_AGENT_PROVIDERS;
  if (fromEnv) return fromEnv;
  return providersFile();
}

export function loadProvidersFile(filePath: string = defaultProvidersPath()): ProvidersFile {
  if (cachedFile && cachedPath === filePath) return cachedFile;
  let result: ProvidersFile = {};
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      result = validateProvidersFile(parsed);
    } catch (error) {
      throw new Error(`providers config is invalid (${filePath}): ${(error as Error).message}`);
    }
  }
  cachedFile = result;
  cachedPath = filePath;
  return result;
}

function validateProvidersFile(value: unknown): ProvidersFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("root must be an object");
  }
  const result: ProvidersFile = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`provider "${id}" must be an object`);
    }
    const config = raw as Record<string, unknown>;
    const baseURL = requiredString(config.baseURL, id, "baseURL");
    const apiKeyEnv = requiredString(config.apiKeyEnv, id, "apiKeyEnv");
    const model = requiredString(config.model, id, "model");
    const name = optionalString(config.name, id, "name");
    if (config.kind !== undefined && config.kind !== "openai" && config.kind !== "anthropic") {
      throw new Error(`provider "${id}" kind must be "openai" or "anthropic"`);
    }
    let headers: Record<string, string> | undefined;
    if (config.headers !== undefined) {
      if (!config.headers || typeof config.headers !== "object" || Array.isArray(config.headers)) {
        throw new Error(`provider "${id}" headers must be an object of strings`);
      }
      headers = {};
      for (const [key, headerValue] of Object.entries(config.headers)) {
        if (typeof headerValue !== "string") {
          throw new Error(`provider "${id}" header "${key}" must be a string`);
        }
        headers[key] = headerValue;
      }
    }
    result[id] = {
      baseURL,
      apiKeyEnv,
      model,
      ...(name ? { name } : {}),
      ...(config.kind ? { kind: config.kind } : {}),
      ...(headers ? { headers } : {}),
    };
  }
  return result;
}

function requiredString(value: unknown, id: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`provider "${id}" ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, id: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, id, field);
}

export function saveProvidersFile(file: ProvidersFile, filePath: string = defaultProvidersPath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  cachedFile = undefined;
  cachedPath = undefined;
}

export function initProvidersFile(
  filePath: string = defaultProvidersPath(),
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
): { created: boolean; path: string } {
  if (existsSync(filePath)) {
    return { created: false, path: filePath };
  }
  const seeded: ProvidersFile = {};
  for (const preset of presets) {
    seeded[preset.id] = {
      name: preset.name,
      baseURL: preset.baseURL,
      apiKeyEnv: preset.apiKeyEnv,
      model: preset.model,
      ...(preset.kind ? { kind: preset.kind } : {}),
      ...(preset.headers ? { headers: preset.headers } : {}),
    };
  }
  saveProvidersFile(seeded, filePath);
  return { created: true, path: filePath };
}

export function findProvider(
  id: string,
  file: ProvidersFile,
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
): { config: UserProviderConfig; source: "user" | "preset" } | undefined {
  const userCfg = file[id];
  if (userCfg) return { config: userCfg, source: "user" };
  const preset = presets.find((p) => p.id === id);
  if (preset) {
    return {
      config: presetToUserConfig(preset),
      source: "preset",
    };
  }
  return undefined;
}

export function listKnownProviders(
  file: ProvidersFile,
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
): Array<{ id: string; name: string; baseURL: string; apiKeyEnv: string; model: string; kind?: "openai" | "anthropic"; source: "user" | "preset" }> {
  const byId = new Map<string, { id: string; name: string; baseURL: string; apiKeyEnv: string; model: string; kind?: "openai" | "anthropic"; source: "user" | "preset" }>();
  for (const preset of presets) {
    byId.set(preset.id, {
      id: preset.id,
      name: preset.name,
      baseURL: preset.baseURL,
      apiKeyEnv: preset.apiKeyEnv,
      model: preset.model,
      ...(preset.kind ? { kind: preset.kind } : {}),
      source: "preset",
    });
  }
  for (const [id, cfg] of Object.entries(file)) {
    byId.set(id, {
      id,
      name: cfg.name ?? id,
      baseURL: cfg.baseURL,
      apiKeyEnv: cfg.apiKeyEnv,
      model: cfg.model,
      ...(cfg.kind ? { kind: cfg.kind } : {}),
      source: "user",
    });
  }
  return [...byId.values()];
}

export function presetToUserConfig(preset: ProviderPreset): UserProviderConfig {
  return {
    baseURL: preset.baseURL,
    apiKeyEnv: preset.apiKeyEnv,
    model: preset.model,
    name: preset.name,
    ...(preset.kind ? { kind: preset.kind } : {}),
    ...(preset.headers ? { headers: preset.headers } : {}),
  };
}
