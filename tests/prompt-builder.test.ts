import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PromptBuilder, joinPromptSections } from "../dist/agent/prompt-builder.js";
import { PromptLoader } from "../dist/config/prompt-loader.js";

test("PromptBuilder: composes system, graph context, and role task in order", () => {
  const built = new PromptBuilder(new PromptLoader()).build({
    spec: { file: "builtin:explorer" },
    context: "## Objective\nInspect the target",
    extra: "## Current Intent\nTrace input",
  });
  assert.equal(built.fromConfig, true);
  assert.ok(built.prompt.indexOf("# Explorer Role") < built.prompt.indexOf("## Objective"));
  assert.ok(built.prompt.indexOf("## Objective") < built.prompt.indexOf("## Current Intent"));
  assert.match(built.promptHash, /^[a-f0-9]{64}$/);
  assert.equal(built.manifest.components[0]!.source, "builtin:explorer");
  assert.deepEqual(
    built.manifest.components.map((component) => component.kind),
    ["primary", "graph-context", "assignment"],
  );
});

test("joinPromptSections: omits empty sections without extra separators", () => {
  assert.equal(joinPromptSections("system", "", undefined, "task"), "system\n\ntask");
});

test("PromptBuilder: renders task Skills as preinstalled names", () => {
  const built = new PromptBuilder(new PromptLoader()).build({
    spec: {
      file: "builtin:explorer",
      skills: ["decx-cli", "app-vulnhunt"],
    },
  });

  assert.match(built.prompt, /Configured Skill: decx-cli/);
  assert.match(built.prompt, /Configured Skill: app-vulnhunt/);
  assert.match(built.prompt, /Load it by name/);
  assert.deepEqual(
    built.manifest.components.filter((component) => component.kind === "skill")
      .map((component) => component.source),
    ["skill:decx-cli", "skill:app-vulnhunt"],
  );
});
