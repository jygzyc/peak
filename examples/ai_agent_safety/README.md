# AI Agent Safety Board

This example runs two independent domain projects:

1. **Latest AI Safety Intelligence** produces a current brief for engineering and governance decisions.
2. **AI Agent Guardrail Design** produces an implementable security blueprint for an HTTP-native, tool-using Agent.

Each project Goal names only its final outcome. `board.skills` installs and allows the `ai-agent-safety` Skill, while each phase-level Custom Profile explicitly selects it through `customProfile.skills`. Only the active Plan, Supervise, or Execute profile's Skill names enter that Worker prompt; Finalize inherits the selected Execute profile. The selected names are recorded under `customProfile.skills` in the local `graph-*.json` snapshot, but the snapshot contains no top-level Skills or Worker configuration.

The Skill supplies the domain method: evidence selection, source verification, incident analysis, threat and control records, quality gates, document structure, and file delivery. Custom Profiles add focused guidance when the assigned work concerns a paper or standard, an incident, threat modeling, control design, or final editing.

Task decomposition and dependency management are deliberately absent from the domain configuration. Peak analyzes the Goal and available context and decides how to organize the work.

## Expected deliverables

- `ai-safety-intelligence-brief.md`
- `guardrail-blueprint.md`

Intermediate work normally returns concise results without files. For a completed deliverable, the worker returns the entire Markdown body inline with the filename and `text/markdown` media type required by the Skill. Peak stores the content and materializes the file next to `task.json`; workers do not write files directly.

## Run

Both configured workers use the Pi Agent SDK with `deepseek-v4-flash`. Authenticate Pi first, then run:

```bash
npm run build
node dist/cli.js serve --port 8000
node dist/cli.js prepare examples/ai_agent_safety --graph-url http://127.0.0.1:8000
node dist/cli.js dispatch examples/ai_agent_safety --graph-url http://127.0.0.1:8000
```

`serve` runs independently in the background. `prepare` creates every missing Project and writes the complete UUID set back to `task.json`; `dispatch` then runs Workers in the foreground against that Server. Later runs reuse the persisted IDs. Use `node dist/cli.js stop` when finished.
