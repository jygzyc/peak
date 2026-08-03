# AI Agent Safety Board

This example contains two related but non-overlapping Projects:

1. **Latest AI Safety Intelligence** produces one concise brief with exactly five sourced findings and three cross-cutting trends.
2. **AI Agent Guardrail Design** produces one consolidated implementation blueprint for an HTTP-native, tool-using Agent, including one acceptance-criteria table.

Both projects demonstrate Peak's depth-first planning: each proof grows as a **multi-level DAG**, not a single-level tree. Plan must start every new Intent from the current leaf Facts and prefer deepening an established line of inquiry (scoping, evidence collection, cross-checking, refinement, synthesis) over opening a new branch from `origin`. **Depth is not limited** — a line may extend for as many levels as the Goal requires; only breadth is bounded so the example does not fan out indefinitely.

Neither Project declares a dependency on the other or prescribes which results to reuse. The Board has no Goal or Graph of its own, and each Project has an independent UUID Graph and completion condition. The runtime exposes eligible cross-Project evidence only as candidate `FactRef` hyperlink nodes containing `projectId`, `factId`, and the immutable Fact `description`; the AI decides whether any candidate is relevant to the current Project Goal. Source Fact entities and Artifacts remain in their original Project shards.

Project `id` values start empty. On the first `peak run`, Peak creates each Project and atomically writes its UUID back to `task.json`. Later runs attach those UUIDs and reuse their existing Graphs. Another Board may reference the same UUID when it intentionally reuses the same Project, but the same active Project must not be scheduled by multiple Runtime processes concurrently.

The optional custom profiles demonstrate phase-scoped prompt injection by task nature:

- a scoping profile fixes the deliverable contract and evidence rules before evidence collection;
- a profile applies to current primary research or standards evidence;
- a profile applies to concrete incident analysis;
- a profile applies to implementable guardrail/control design;
- a synthesis profile produces the final bounded deliverable from existing leaves only;
- the single Supervise profile audits only completion-blocking evidence defects.

Each profile `description` tells Plan when its prompt should be injected; Plan persists the selected description and its digest on the Intent, never on Facts. Plan sees the Source, Goal, complete current leaf frontier, open Intents, unconsumed Hints, and pending external leaves, and prefers deepening the most relevant current leaf before opening a new branch.

Worker routing in this example:

- one Pi worker using `deepseek-v4-flash` performs Plan and Supervise;
- a second Pi worker using `deepseek-v4-flash` performs Execute with up to two concurrent runs.

Using one authenticated backend keeps the example reproducible while still exercising phase routing, depth-first planning, and concurrent Execute reservations.

```bash
npm run build
node dist/cli.js run examples/ai_agent_safety
```

Authenticate Pi before running. Project state is stored under `PEAK_HOME/projects/<uuid>/`. Workers are never allocated a workspace and never write files: when a Fact needs detailed evidence, the Execute contract returns the file content inline and the Runtime stores it as a content-addressed Artifact under the Project shard's `artifacts/` directory. On completion, the Runtime materializes the synthesis Artifacts that carry a content-based `filename` (for example `ai-safety-intelligence-brief.md` or `guardrail-blueprint.md`) next to `task.json` — these are the expected final deliverables.
