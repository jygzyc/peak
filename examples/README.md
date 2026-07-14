# Examples

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

## vulnhunt-task.json

A real Android app vulnerability-hunting task, **fully self-contained in this
one file**. Peak is a generic framework (graph + blackboard + planner/explorer/
evaluator loop) that loads all role behavior from external config — so this
task carries the entire vulnhunt domain knowledge inline:

- each profile keeps the builtin role prompt as `prompt.file`
  (`agent/prompts/planner.md` etc. — the generic role + output contract), and
- adds the vulnhunt-specific methodology via `prompt.knowledge` /
  `prompt.instructions` (inline text, no external prompt files).

The domain knowledge is adapted from the decx app-vulnhunt methodology:
attack-surface collection, composite exploit-chain routing, and a six-kind
evidence gate (entrypoint → reachability → control → guard → sink → impact).

This task is meant to run against a **real** backend with code-analysis
capability — it does nothing useful under `--mock`.

### Prerequisites

1. **opencode CLI** installed and on PATH, configured with an API key
   (`OPENCODE_API_KEY`) and a model. The explorer/evaluator workers run as
   `opencode run` subprocesses.
2. **Code-analysis capability for the target.** Peak itself has no decompiler.
   Point `task.target` at either:
   - a **decompiled source tree** (`jadx -d <out> target.apk`), so the opencode
     worker can read Java/manifest with its file tools, or
   - an **APK** if your opencode instance has the decx-cli skill wired in (which
     gives it `decx process open` / `decx ard` / `decx code` query tools).

### Run

Edit `examples/vulnhunt-task.json` and replace the `task.target` placeholder
with the absolute path to your APK or decompiled source directory, then:

```bash
peak run examples/vulnhunt-task.json
```

Optional flags:
- `--no-metacog` — disable the background metacog hint loop.
- `--port 25429` — start the dashboard to watch the attack graph grow.

You should see the planner open attack-surface-collection intents, explorers
return candidate facts citing manifest/source evidence, and the evaluator
accept well-traced facts while rejecting inline-only speculation. A completed
run reports the verified facts that form proven exploit chains:

```
[peak] finished: completed
[peak] verified facts: 3
  f001: entrypoint: exported Activity ... receives external Intent extra ...
  f002: control+sink+guard: ... flows to WebView.loadUrl(), no guard
  f003: ...
```

## codex-vulnhunt-task.json

The same app vulnerability-hunting task as `vulnhunt-task.json`, but driven by
the **codex** worker backend instead of opencode. Use this if you have the
[`codex`](https://github.com/openai/codex) CLI installed (rather than opencode)
as your agent runtime.

The only structural difference from `vulnhunt-task.json` is the `workers`
block and each profile's `runtime.worker`:

```jsonc
"workers": {
  "codex": { "kind": "agent", "backend": "codex", "model": "gpt-5.5", "apiKeyEnv": "OPENAI_API_KEY" }
}
```

The codex backend spawns `codex exec --dangerously-bypass-approvals-and-sandbox
--model <model> -` per worker call (prompt passed via stdin to avoid Windows
cmd.exe arg-length/quoting issues). Requirements:

1. **codex CLI** installed and on PATH.
2. `OPENAI_API_KEY` set (or whichever env var `apiKeyEnv` names).
3. Optional: override `model` in the worker config, or set `CODEX_MODEL`. For a
   custom OpenAI-compatible endpoint, set `CODEX_BASE_URL` (the backend wires
   it into codex's `model_providers` config).

Edit `task.target` to point at your APK / decompiled source, then:

```bash
peak run examples/codex-vulnhunt-task.json
```

> Swapping the worker backend is the **only** change needed to move a task
> between agent runtimes — the planner/explorer/evaluator knowledge and the
> graph/blackboard loop are backend-agnostic. The same pattern lets you use
> `claude-code` (`backend: "claude-code"`) or a direct model API
> (`kind: "api"`) by editing the `workers` block alone.

## framework-vulnhunt-task.json

A framework/system-layer vulnerability-hunting task — the framework analogue
of `vulnhunt-task.json`, adapted from the decx framework-vulnhunt methodology.
Where app hunting targets exported components and IPC within an app, framework
hunting targets **Binder/system-server surface**: exposed Binder services,
system providers, PendingIntent dispatch, identity transitions
(`clearCallingIdentity`), transitions/animations, and native/HIDL/HAL surfaces.

The domain knowledge inline differs from the app task in three ways:

- **Composite chains** are Binder/identity-crossing: missing Binder guard →
  clear identity → privileged sink; caller package/UID/user confusion →
  cross-user action; Binder Intent/Bundle/URI → privileged launch/grant;
  provider proxy under system identity; PendingIntent replay; callback/token
  stale authorization; validation-execution gap (LaunchAnyWhere); Parcel
  mismatch; transition/animation control; native socket/HIDL/HAL surface.
- **Evidence gate is seven kinds** (vs. the app's six): `service-entrypoint` →
  `binder-reachability` → `control` → `identity` → `permission-guard`
  (or `appop-guard` / `user-guard`) → `sink` → `impact`.
- **Promotion threshold is 0.8** (vs. 0.7 for apps) — privileged-sink claims
  demand stronger proof.

Prerequisites are the same as `vulnhunt-task.json` (opencode CLI + code-analysis
capability), but the `task.target` should be framework source or a system image
rather than an APK:

```bash
peak run examples/framework-vulnhunt-task.json
```

