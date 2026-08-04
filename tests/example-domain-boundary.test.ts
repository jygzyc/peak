import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { executeCapacity, loadTaskConfig } from "../dist/config/task-config.js";

const INTERNAL_PLANNING_TERMS = /\b(?:Graph|DAG|Intent|Fact|FactRef|Leaf|origin)\b/i;

test("AI safety examples keep outcomes in Goals and methods in Skills", () => {
  const examples = [
    {
      directory: "examples/ai_agent_safety",
      goals: [
        "Produce a current AI safety intelligence brief for engineering and governance decision-making.",
        "Produce an implementable security guardrail blueprint for an HTTP-native, tool-using AI Agent.",
      ],
      skill: join("skills", "ai-agent-safety", "SKILL.md"),
      requiredSkillText: [
        "exactly five high-impact findings",
        "Threat record",
        "Control record",
        "ai-safety-intelligence-brief.md",
        "guardrail-blueprint.md",
        "Do not call filesystem write tools",
      ],
      executeCapacity: 2,
    },
    {
      directory: "examples/ai_agent_zh",
      goals: [
        "产出一份供工程与治理决策使用的当前 AI 安全情报简报",
        "产出一份可实施的快速入手的 AI Agent 安全护栏蓝图",
      ],
      skill: join("skills", "aihot", "SKILL.md"),
      requiredSkillText: [
        "AI HOT",
        "https://aihot.virxact.com/api/v1/",
        "不凭训练记忆回答新闻",
      ],
      executeCapacity: 4,
    },
  ];

  for (const example of examples) {
    const config = loadTaskConfig(example.directory);
    assert.deepEqual(config.board.projects.map((project) => project.goal), example.goals);
    assert.equal(executeCapacity(config), example.executeCapacity, "executeCapacity = sum of execute Worker maxRunning");
    assert.equal(config.phase.execute.maxArtifactBytes, 10 * 1024 * 1024);

    const taskText = readFileSync(join(example.directory, "task.json"), "utf8");
    assert.equal(taskText.includes("maxIntents"), false, "Plan limit is no longer a Board field");
    assert.equal(taskText.includes("args"), false, "args field is no longer a Board field");
    assert.equal(taskText.includes("maxArtifactBytes"), false, "default-only Artifact limit stays out of task.json");
    for (const project of config.board.projects) assert.doesNotMatch(project.goal, INTERNAL_PLANNING_TERMS);
    assert.doesNotMatch(JSON.stringify(config.phase), INTERNAL_PLANNING_TERMS);

    const skillText = readFileSync(join(example.directory, example.skill), "utf8");
    assert.doesNotMatch(skillText, INTERNAL_PLANNING_TERMS);
    for (const required of example.requiredSkillText) assert.ok(skillText.includes(required), `Skill missing: ${required}`);
  }
});
