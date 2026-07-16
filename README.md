# peak

`peak` is a generic TypeScript agent framework for **deep, unbounded exploration tasks**. It runs a planner→explorer→evaluator blackboard loop over a Fact/Intent/Hint graph stored in SQLite, dispatches configurable worker backends, and exposes a local dashboard.

There is no fixed workflow, no depth limit, and no hardcoded business behavior. Task behavior (roles, prompt extensions, models, workers, permissions) is defined by config; generic role system prompts are compiled TypeScript builtins.

## How it works

```
peak run task.json
  └─ GlobalSupervisor dispatches one SessionLoop per task/session:
       server     → owns session Graph access and POST read model
       planner    → reads graph state, opens bounded Intents
       explorer   → executes one Intent, returns a candidate Fact (with evidence)
       evaluator  → judges the Fact against the output contract → pass/deny/pending
       metacog    → background loop, emits Hints when the hunt drifts
     The loop completes naturally when the planner produces no new Intent.
```

Four built-in roles (`planner` / `explorer` / `evaluator` / `metacog`), each fully configurable. Workers (the LLM/agent backend) are swappable per-role without touching the loop or the graph.

## Quick start

```bash
npm install
npm run build
peak run examples/mock-task.json --mock --no-http --no-metacog   # verify the loop (no backend needed)
```

You should see the planner open an intent, the explorer resolve it, the evaluator pass it, and the run finish `completed` with one passed fact.

To run a real task: point a worker at a configured backend and drop `--mock`:

```bash
peak run examples/idea-analysis/task.json   # codex CLI backend, real analysis
```

## Commands

```bash
peak run <task.json>              # run a task (state persists to ~/.peak/sessions/)
peak run <task.json> --mock       # use MockWorker instead of real backends
peak run <task.json> --port 25429 # run with the dashboard HTTP server
peak resume <session>             # resume a stopped/paused session
peak status <session>             # show project status for a session
peak sessions                     # list all analysis sessions
peak search <query>               # search facts across all sessions
peak workers                      # list available worker backends and providers
peak agents                       # list reusable agent configs in ~/.peak/agents/
peak tasks                        # list task configs in ~/.peak/tasks/
```

Common `run` flags: `--mock`, `--no-http`, `--no-metacog`, `--session <name>`, `--port`/`--host`.

## Task configuration

A task is a single JSON file. The minimal task declares only a target and a goal — everything else inherits from the built-in defaults:

```json
{
  "task": { "target": "app.apk", "goal": "find vulnerabilities", "session": "app-audit" }
}
```

To customize a role, declare it under `profiles`. Each profile binds together: a **runtime** (which worker), a **prompt** (role + knowledge), a **context** policy (how much of the graph it sees), **permissions** (what graph mutations its output may trigger), and an **output contract** (the JSON shape it must return).

### Top-level shape

```text
task        required — target, goal, optional session/name
profiles    role bindings for planner / explorer / evaluator / metacog
workers     low-level backend configs (agent CLI / model API / mock)
scheduler   optional — concurrency knobs only (NOT a workflow)
control     optional — which profile drives planning/metacog
```

There is **no `workflow` concept** and no depth limit. Termination is natural (planner produces no new intent). `scheduler` is the only execution-resource block; task or global configs containing `workflow` are rejected.

### Session naming priority

`--session` flag > `task.session` > derived from `task.target` (e.g. `app.apk` → `app`) > derived from the task filename.

### Output contracts

Each role returns a JSON envelope validated against its contract before any graph mutation:

| Role | Contract | Envelope shape |
|---|---|---|
| planner | `main_decision` | `{ "kind": "decisions", "data": { createIntents, failIntents, consumeHints, concludeRun } }` |
| explorer | `candidate_fact` | `{ "kind": "fact", "data": { description, evidence, confidence } }` |
| evaluator | `verdict` | `{ "kind": "verdict", "data": { decision, reason, confidence, requiredConditions } }` |
| metacog | `hints` | `{ "kind": "hints", "data": { hints: [{ content }] } }` |

### Permissions

Capabilities a profile's output may trigger (enforced by the decision applier):

| Permission | Who | Allows |
|---|---|---|
| `create_intent`, `fail_intent` | planner | open / abandon investigation directions |
| `create_subagent_explorer`, `stop_subagent_explorer` | planner | dispatch / stop explorers |
| `handle_intent`, `write_candidate_fact` | explorer | execute an Intent and submit its candidate Fact |
| `change_fact`, `receive_fact_broadcast` | evaluator | pass/deny/pending a candidate or assess a broadcast |
| `create_hint`, `send_fact_broadcast` | metacog | steer the planner and broadcast reviewed facts |
| `get_graph` | metacog | request the metacog Graph view generated by the server |

### Prompt assembly

A profile's prompt is assembled from its `prompt` spec:

- `file` (required) — the system prompt source: a compiled builtin such as `builtin:planner`, or a path to your own prompt file.
- `knowledge` — domain-knowledge text appended to the preamble. Each entry is either a file path or **raw inline text** (if it isn't a path, it's used verbatim). This is how task-specific methodology is injected without editing the framework.
- `rules` — short behavioral rules, appended the same way as `knowledge`.
- `instructions` — a final instruction line appended last.
- `concludeFile` — optional builtin source or prompt file for the conclude phase.

At runtime the ContextBuilder also **prepends** dynamic graph state (objective, verified facts, open intents, dead-ends, recent verdicts) according to the profile's `context.graphView`.

## Complete annotated example

A fully self-contained task that customizes all roles with inline domain knowledge. Peak stays generic; all role behavior lives in task configuration.

```jsonc
{
  // ── task: required ──────────────────────────────────────────────────────
  "task": {
    "target": "/abs/path/to/decompiled-source",  // what to analyze (path/URI)
    "goal": "prove exploitable attack paths from entrypoint to impact",
    "session": "my-audit"                         // optional; else derived from target
  },

  // ── profiles: role bindings (omitted roles keep builtin defaults) ───────
  "profiles": {
    "planner": {
      "role": "planner",
      "runtime": { "worker": "codex" },          // which worker drives this role
      "prompt": {
        "file": "builtin:planner",              // compiled role system prompt + output contract
        "knowledge": [                           // inline domain knowledge (or file paths)
          "Routing matrix: exported entry -> intent redirect -> private component; provider leak -> URI grant -> file disclosure; WebView/deeplink -> JS bridge -> sink."
        ],
        "instructions": "Collect attack surface first, then decompose along composite chains."
      },
      "context": { "graphView": "full" },        // planner sees the whole graph
      "permissions": ["create_intent","fail_intent","handle_hint","create_subagent_explorer","stop_subagent_explorer","create_end_fact"],
      "output": { "contract": "main_decision" },
      "cooldownSteps": 3                         // min steps between planner runs
    },

    "explorer": {
      "role": "explorer",
      "runtime": { "worker": "codex" },
      "prompt": {
        "file": "builtin:explorer",
        "concludeFile": "builtin:explorer-conclude",  // fallback summarize phase
        "knowledge": [
          "Probe-first: inspect manifest and exported components before reading source. Cite concrete evidence (manifest line, source location) in every fact."
        ],
        "instructions": "Cite concrete evidence in every fact."
      },
      "context": { "graphView": "focused", "maxFacts": 30 },  // sees linked facts only
      "permissions": ["handle_intent","write_candidate_fact"],
      "output": { "contract": "candidate_fact" },
      "maxActive": 2                              // concurrency cap for explorers
    },

    "evaluator": {
      "role": "evaluator",
      "runtime": { "worker": "codex" },
      "prompt": {
        "file": "builtin:evaluator",
        "knowledge": [
          "Evidence gate: accept only if reachable, controllable, deeply traced, and impactful. Reject inline-only speculation."
        ]
      },
      "context": { "graphView": "evidence-only" },           // sees only the candidate under review
      "permissions": ["change_fact","receive_fact_broadcast"],
      "output": { "contract": "verdict" }
    },

    "metacog": {
      "role": "metacog",
      "runtime": { "worker": "codex" },
      "prompt": { "file": "builtin:metacog" },               // compiled metacog system prompt
      "context": { "graphView": "summary" },                 // sees a compact graph summary
      "permissions": ["create_hint","get_graph","send_fact_broadcast"],
      "output": { "contract": "hints" }
      // "triggers": { "everySeconds": 30 }                  // optional: override the 30s interval
    }
  },

  // ── workers: low-level backends (see "Worker backends" below) ──────────
  "workers": {
    "codex": {
      "kind": "agent",            // spawn an agent CLI subprocess
      "backend": "codex",         // which CLI: codex | claude-code | opencode | process
      "model": "gpt-5.5",         // optional model override
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  },

  // ── scheduler: optional execution knobs (NOT a workflow) ───────────────
  "scheduler": { "maxConcurrent": 3, "refillPerTick": 1, "workerLeaseMs": 1800000 },

  // ── control: which profiles drive planning/metacog ─────────────────────
  "control": { "mainProfile": "planner", "metacogProfile": "metacog" }
}
```

**Key points:**

- `prompt.file` may point at a compiled role prompt (`builtin:planner`, `builtin:explorer`, `builtin:evaluator`, or `builtin:metacog`) or an external file. Domain behavior belongs in `knowledge`, `rules`, `skills`, and `instructions`.
- Roles never receive a Graph/SQLite handle. The server writes a role-scoped graph snapshot to `sessions/<session>/agents/<agentId>/context.json`; the validated response is written to `output.json` before any permission-checked Graph commit. `record.json` is audit data, not Graph state.
- Session Graphs and the FederationBus are always on-disk SQLite databases; there is no in-memory or temporary database mode.
- Swapping backends is the **only** change needed to move a task between agent runtimes — edit `workers` and each profile's `runtime.worker`.
- Omit any role from `profiles` to keep the builtin default for it. Omit `profiles` entirely for a minimal task.

## Worker backends

Workers are low-level execution backends. Each profile's `runtime.worker` names a worker from the `workers` map.

| `kind` | `backend` | What it does | Requires |
|---|---|---|---|
| `agent` | `codex` | `codex exec -` (prompt via stdin) | codex CLI on PATH, `OPENAI_API_KEY` |
| `agent` | `claude-code` | `claude -p -- <prompt>` | claude CLI on PATH, `ANTHROPIC_API_KEY` |
| `agent` | `opencode` | `opencode run --format json -` (prompt via stdin) | opencode CLI on PATH, configured provider |
| `agent` | `opencode-http` | HTTP to a running `opencode serve` | opencode server at `127.0.0.1:4096` |
| `agent` | `process` | generic `<command> <args>` | whatever `command` is configured |
| `api` | — | configuration is rejected for role execution because it cannot read session JSON artifacts | — |
| `mock` | — | canned responses by regex match | nothing (used by `--mock`) |

```jsonc
// agent CLI backends
"workers": {
  "codex":    { "kind": "agent", "backend": "codex", "model": "gpt-5.5", "apiKeyEnv": "OPENAI_API_KEY" },
  "opencode": { "kind": "agent", "backend": "opencode" },
  "claude":   { "kind": "agent", "backend": "claude-code", "apiKeyEnv": "ANTHROPIC_API_KEY" }
}

// direct model API (no agent loop / no tools — fits planner/evaluator, not explorers that read code)
"workers": {
  "llm": { "kind": "api", "provider": "openai", "model": "gpt-4.1", "apiKeyEnv": "OPENAI_API_KEY" }
}
```

Run `peak workers` to list available backends and providers. Provider presets (OpenAI, Anthropic, DeepSeek, GLM, etc.) are built in and auto-activate when their `apiKeyEnv` is present in the environment; override them by writing `~/.peak/providers.json` by hand (a `Record<providerId, { baseURL, apiKeyEnv, model, kind? }>`).

## Reusable configs (`~/.peak/`)

For tasks you run repeatedly, Peak home keeps reusable pieces so individual task files stay short. Override the root with `PEAK_HOME` (default `~/.peak`):

```text
~/.peak/
├── config.json          global baseline: default workers/control (optional)
├── agents/<name>.json   reusable role patches, injected into builtin slots
├── tasks/<name>.json    task configs (target/goal/session + agent refs + workers)
├── sessions/<session>/  per-session execution state (analysis.db)
└── providers.json       model provider configs (api keys, base URLs)
```

**`~/.peak/config.json`** — a global baseline merged into every task (under the builtin defaults, overriden by the task file):

```json
{ "workers": { "codex": { "kind": "agent", "backend": "codex" } } }
```

**`~/.peak/agents/<name>.json`** — a **patch** over a builtin slot. Declared fields override the builtin default; omitted fields keep it. Referenced from a task via `"agents": ["<name>", ...]`:

```json
{
  "slot": "explorer",
  "runtime": { "worker": "codex", "model": "gpt-5.5" },
  "prompt": { "rules": ["strict-review.md"] },
  "context": { "maxFacts": 30 },
  "maxActive": 2
}
```

**`~/.peak/tasks/<name>.json`** — a task that references reusable agents:

```json
{
  "task": { "target": "app.apk", "goal": "find vulnerabilities", "session": "app-audit" },
  "agents": ["android-source-finder", "strict-reviewer"],
  "workers": { "codex": { "kind": "agent", "backend": "codex" } }
}
```

## Examples

Ready-to-run task configs live in [`examples/`](examples/), with a dedicated [examples/README.md](examples/README.md):

- **`mock-task.json`** — runs the full loop under `--mock` (no backend needed). Verify the runtime is wired correctly.
- **`app-vuln-analysis/`** — one-App vulnerability analysis, including single-session and federated task configs.
- **`two-app-vuln-analysis/`** — two distinct Apps analyzed by two federated sessions.
- **`idea-analysis/`** — domain-neutral deep analysis of an idea brief.
- **`requirement-implementation/`** — a small implementation task against a real workspace fixture.

Each scenario bundle keeps domain behavior in prompts, rules, skills, and knowledge files outside the runtime source. See the examples README for the acceptance-test mapping.

## Termination model

`peak` is an **unbounded exploration agent**: no depth limit, no stop gate, no forced stagnation pause. A run completes **naturally** when the planner produces no new intent and none are in flight (`openIntents === 0` and no deferred candidates). Stagnation is handled by the metacog loop, which emits hints the planner acts on. To stop a run, send a `stop` directive via the HTTP API or interrupt the process.

## Build, test, package

All commands run from the repo root. Requires Node ≥ 22.5.

```bash
npm install            # install dependencies (once)
npm run typecheck      # tsc --noEmit — fast type check (run before commits)
npm run build          # clean + tsc + copy dashboard.html → dist/
npm test               # builds first, then node --test tests/*.test.ts
node --test tests/<name>.test.ts   # focused single file (after a build)
npm run smoke          # exercises the built CLI end-to-end
npm run pack           # typecheck + esbuild single-file bundle → dist-packages/<tarball>
```

Tests import compiled output from `../dist/**.js` (never `../src/`), so a build is required before tests see source changes — `npm test` builds first for this reason.

`pack` bundles `src/cli.ts` and the TypeScript builtin prompts into a minified `dist/index.js` (externals: `commander`, `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`), ships the dashboard alongside it (no sourcemaps, no source), then `npm pack`s it into `dist-packages/` with a `manifest.json` (name, version, sizes, SHA-256).

The same bundling runs automatically as a `prepack` lifecycle hook — so `npm pack` and `npm publish` always produce the minified single-file bundle, never the raw `tsc` dev output. Install it standalone:

```bash
npm install -g dist-packages/jygzyc-peak-<version>.tgz
peak --help
```
