import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_PRESETS } from "../dist/config/provider-presets.js";
import {
  initProvidersFile,
  findProvider,
  presetToUserConfig,
  listKnownProviders,
  saveProvidersFile,
  loadProvidersFile,
} from "../dist/config/providers-config.js";

/**
 * Regression tests for the anthropic provider `kind` link (docs 09-config.md
 * §9.6 / 07-worker-providers.md §7.3). Previously the anthropic preset had no
 * `kind`, and every preset→UserProviderConfig copy site dropped `kind`/`headers`,
 * so ConfiguredProvider fell back to the OpenAI branch and called the Anthropic
 * API with the OpenAI protocol — always failing.
 */

test("provider-presets: anthropic preset declares kind=anthropic", () => {
  const anthropic = PROVIDER_PRESETS.find((p) => p.id === "anthropic");
  assert.ok(anthropic, "anthropic preset must exist");
  assert.equal(anthropic!.kind, "anthropic");
});

test("provider-presets: openai-like presets omit kind (default openai)", () => {
  const openai = PROVIDER_PRESETS.find((p) => p.id === "openai");
  assert.ok(openai);
  assert.equal(openai!.kind, undefined);
});

test("presetToUserConfig: copies kind and headers from preset", () => {
  const preset = {
    id: "custom-anthropic",
    name: "Custom Anthropic",
    baseURL: "https://api.custom.example/v1",
    apiKeyEnv: "CUSTOM_KEY",
    model: "claude-x",
    description: "test",
    kind: "anthropic" as const,
    headers: { "x-custom": "yes" },
  };
  const cfg = presetToUserConfig(preset);
  assert.equal(cfg.kind, "anthropic");
  assert.deepEqual(cfg.headers, { "x-custom": "yes" });
  assert.equal(cfg.model, "claude-x");
});

test("presetToUserConfig: omits kind/headers when preset has none", () => {
  const cfg = presetToUserConfig(PROVIDER_PRESETS.find((p) => p.id === "openai")!);
  assert.equal(cfg.kind, undefined);
  assert.equal(cfg.headers, undefined);
});

test("initProvidersFile: seeds providers.json WITH kind for anthropic", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-pcfg-"));
  const filePath = join(dir, "providers.json");
  try {
    const { created } = initProvidersFile(filePath);
    assert.ok(created);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(raw.anthropic.kind, "anthropic");
    // openai-like presets should not carry an explicit kind
    assert.equal(raw.openai.kind, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findProvider: preset fallback carries anthropic kind", () => {
  // No user file entries → preset fallback path must still provide kind.
  const match = findProvider("anthropic", {});
  assert.ok(match);
  assert.equal(match!.source, "preset");
  assert.equal(match!.config.kind, "anthropic");
});

test("findProvider: user override of anthropic keeps user kind", () => {
  const userFile = {
    anthropic: {
      baseURL: "https://custom.anthropic/v1",
      apiKeyEnv: "MY_KEY",
      model: "claude-custom",
      kind: "anthropic" as const,
    },
  };
  const match = findProvider("anthropic", userFile);
  assert.ok(match);
  assert.equal(match!.source, "user");
  assert.equal(match!.config.kind, "anthropic");
  assert.equal(match!.config.baseURL, "https://custom.anthropic/v1");
});

test("listKnownProviders: includes kind for anthropic entry", () => {
  const list = listKnownProviders({});
  const anthropic = list.find((p) => p.id === "anthropic");
  assert.ok(anthropic);
  assert.equal(anthropic!.kind, "anthropic");
  const openai = list.find((p) => p.id === "openai");
  assert.ok(openai);
  assert.equal(openai!.kind, undefined);
});

test("loadProvidersFile/saveProvidersFile: kind round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-pcfg-"));
  const filePath = join(dir, "providers.json");
  try {
    saveProvidersFile({
      anthropic: {
        baseURL: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        model: "claude-x",
        kind: "anthropic",
        headers: { "anthropic-version": "2023-06-01" },
      },
    }, filePath);
    // loadProvidersFile caches by path; read the parsed result.
    const loaded = loadProvidersFile(filePath);
    assert.equal(loaded.anthropic.kind, "anthropic");
    assert.deepEqual(loaded.anthropic.headers, { "anthropic-version": "2023-06-01" });
    // Also confirm the raw JSON contains kind (not stripped on write).
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(raw.anthropic.kind, "anthropic");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProvidersFile: rejects malformed JSON instead of silently selecting presets", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-pcfg-invalid-"));
  const filePath = join(dir, "providers.json");
  try {
    writeFileSync(filePath, "{not-json", "utf-8");
    assert.throws(() => loadProvidersFile(filePath), /providers config is invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProvidersFile: validates required provider fields and headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-pcfg-shape-"));
  const filePath = join(dir, "providers.json");
  try {
    writeFileSync(filePath, JSON.stringify({ broken: { baseURL: "https://example.test", apiKeyEnv: "KEY" } }));
    assert.throws(() => loadProvidersFile(filePath), /broken.*model.*non-empty string/);

    writeFileSync(filePath, JSON.stringify({
      broken: {
        baseURL: "https://example.test",
        apiKeyEnv: "KEY",
        model: "model",
        headers: { authorization: 123 },
      },
    }));
    assert.throws(() => loadProvidersFile(filePath), /header.*authorization.*string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
