# AI Agent Safety Board

This example contains two related but non-overlapping Projects:

1. **Latest AI Safety Intelligence** collects and analyzes current AI safety research, incidents, standards, policies, and engineering practices, then produces a sourced summary.
2. **AI Agent Guardrail Design** produces an actionable AI Agent guardrail construction plan.

Neither Project declares a dependency on the other or prescribes which results to reuse. The Board has no Goal or Graph of its own, and each Project has an independent UUID Graph and completion condition. The runtime exposes eligible cross-Project evidence only as candidate `FactRef` hyperlink nodes containing `projectId`, `factId`, and the immutable Fact `description`; the AI decides whether any candidate is relevant to the current Project Goal. Source Fact entities and Artifacts remain in their original Project shards.

Project `id` values start empty. On the first `peak run`, Peak creates each Project and atomically writes its UUID back to `task.json`. Later runs attach those UUIDs and reuse their existing Graphs. Another Board may reference the same UUID when it intentionally reuses the same Project, but the same active Project must not be scheduled by multiple Runtime processes concurrently.

Worker routing in this example:

- Pi with `zai-coding-cn/glm-5.2` performs Plan and Supervise;
- Codex with an empty `model` is a lower-priority Plan fallback and uses its own default model;
- OpenCode with `minimax/MiniMax-M3` performs Execute.

```bash
npm run build
node dist/cli.js run examples/ai_agent_safety
```

Authenticate the configured Agent tools before running. Project state is stored under `PEAK_HOME/projects/<uuid>/`.
