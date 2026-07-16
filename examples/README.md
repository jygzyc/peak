# Examples

## End-to-end scenario matrix

The repository includes four explicit acceptance-oriented task bundles:

| Scenario | Bundle | Automated acceptance |
| --- | --- | --- |
| One App / one session vulnerability analysis | `app-vuln-analysis/tasks/single-app.json` | `tests/single-app-vuln-acceptance.test.ts` |
| Two distinct Apps / two federated sessions | `two-app-vuln-analysis/` | `tests/two-app-dual-session-vuln-acceptance.test.ts` |
| Domain-neutral idea deep analysis | `idea-analysis/` | `tests/idea-analysis-acceptance.test.ts` |
| Requirement implementation with real workspace mutation | `requirement-implementation/` | `tests/requirement-implementation-acceptance.test.ts` |

The App fixtures are authorized static-analysis inputs only. The deterministic
acceptance tests use MockWorker responses while exercising the real graph,
roles, federation and completion protocol. The task JSON files select a Codex
worker for manual runs in an appropriately configured local environment. See
[`docs/14-acceptance-scenarios.md`](../docs/14-acceptance-scenarios.md) for the
evidence required from each scenario.

## mock-task.json

A minimal task config that runs the peak loop with no external dependencies.
Profiles, workers, and prompts are all inherited from the builtin defaults —
only the required `task.target` / `task.goal` / `task.session` are declared.

Run it with the mock worker (no real model backend needed):

```bash
peak run examples/mock-task.json --mock --no-http --no-metacog
```

You should see the loop tick once: the planner opens an intent, the explorer
resolves it to a candidate fact, the evaluator accepts it, and the run
finishes as `completed` with one verified fact.

```bash
[peak] finished: completed
[peak] verified facts: 1
  f001: MOCK FACT: target exposes an entry point
```

`--mock` registers a canned scenario (planner → explorer → evaluator → accept)
on the worker pool, so this needs no model provider or agent CLI installed.
Drop the `--mock` flag to drive the same task with real backends declared in
your task config or `~/.peak/config.json`.
