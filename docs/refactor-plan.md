# Peak target-aligned refactor plan

This plan uses [`target.md`](./target.md) as the product contract. The implementation is a single first-version design: one Prompt pipeline, one RoleContext contract, one role-output submission boundary, and one SQLite schema.

## 1. Core design

### 1.1 RoleContext is the only dynamic role input

For every execution, the Server resolves assignment references and writes one immutable `RoleContext` v1 JSON artifact. Its top-level shape is:

```text
version
projectId / graphSeq
profile: id / role / description / tools / skills
task: target / goal
assignment: role-specific tagged union
graph: profile-scoped structured projection
```

The assignment kinds are:

- Planner: Hints, recent verdicts, and broadcast assessments.
- Explorer: one claimed Intent and its ordered parent Facts.
- Evaluator: one candidate Fact and its provenance, one pending Fact with new pass Facts, or one broadcast and local pending Facts.
- Metacog: one accepted Fact review or one final root-subtree review.

The Prompt contains only the artifact path, identity, graph sequence, and SHA-256. Dynamic Fact, Intent, Hint, task, and broadcast text is never copied into the Prompt.

### 1.2 Every role uses one Prompt format

The fixed section order is:

```text
<SYSTEM_ROLE>
<USER_ROLE>
<EXPLORER_ROLES> or <EVALUATOR_ROLES>, when applicable
<NEEDED_TOOLS>
<NEEDED_SKILLS>
<GRAPH_CONTEXT>
<INPUT_CONTRACT>
<OUTPUT_CONTRACT>
```

- `<SYSTEM_ROLE>` is always the builtin protocol role and cannot be replaced by Agent configuration.
- `<USER_ROLE>` contains the optional custom Prompt file, rules, knowledge, and instructions.
- Only Planner receives `<EXPLORER_ROLES>`, including Explorer id, description, tools, and skills.
- Only Explorer receives `<EVALUATOR_ROLES>`, including Evaluator id and description.
- Evaluator and Metacog receive no role catalog.
- Configured text is escaped before composition.
- The Prompt manifest records every rendered section in order with its source, size, and hash.

### 1.3 Routing is selected by roles and persisted

- Planner must select an Explorer profile for every new Intent.
- Explorer must select an Evaluator profile for every candidate Fact.
- The selected ids are stored on the Intent and Fact and remain stable across resume.
- A Project has exactly one Planner and one Metacog.
- Multiple Explorers and Evaluators are supported.
- Broadcast evaluation uses the sole Evaluator, or the canonical `evaluator` profile when several exist.

### 1.4 Output enters Graph through one Server service

`RoleOutputService` binds a Worker result to the exact context artifact, verifies its hash and execution identity, parses one raw `{ "kind", "data" }` JSON object, applies the fixed contract and permissions, then commits the Graph operation.

Invalid transport results, JSON, contracts, routes, permissions, or context bindings leave only the context artifact. They produce no canonical output, Graph mutation, or success operation in `main.log`.

## 2. Runtime order

One Project step runs in this order:

1. Apply Directives.
2. Evaluate pending broadcasts.
3. Run Planner when needed.
4. Dispatch requested open Intents.
5. Evaluate candidate Facts.
6. Run Metacog for each accepted Fact and the final review.
7. Check local and project-group completion.

Every accepted Fact is reviewed once and broadcast once. The durable send or receive operation is appended to the owning Project's `main.log` before the in-memory FederationBus state advances.

## 3. Graph and UI projection

- Fact is a graph node.
- Intent is a labeled, status-colored edge between ordered parent Facts and its concluded Fact.
- Hint is an independent node; a targeted Hint uses a dashed association to the Intent destination.
- Unresolved Intent endpoints use UI-only anchors and never create synthetic Graph Facts.
- Dashboard APIs return consumed and unconsumed Hints.

## 4. Implementation gates

| Gate | Primary implementation | Automated evidence |
| --- | --- | --- |
| Structured RoleContext, Prompt format, role visibility, and output application | `src/agent/context-builder.ts`, `src/agent/prompt-builder.ts`, `src/server/project-graph-reader.ts`, `src/server/role-output-service.ts` | `tests/mechanisms/agent-flow.test.ts` |
| Persistent root/normal Fact, Intent, Hint, Directive, and derived end flow | `src/graph/sqlite-graph.ts` | `tests/mechanisms/graph-flow.test.ts` |
| Two-level semantic routing and role execution | `src/agent/decision-applier.ts`, `src/project/project-loop.ts` | `tests/mechanisms/runtime-flow.test.ts` |
| Federation reference resolution, delivery history, and completion barrier | `src/graph/federation-bus.ts`, `src/project/metacog-supervisor.ts`, `src/project/supervisor.ts` | `tests/mechanisms/graph-flow.test.ts`, `tests/mechanisms/runtime-flow.test.ts` |
| HTTP Project isolation, RoleContext transport, and Directive ingress | `src/server/http-server.ts`, `src/server/project-graph-reader.ts` | `tests/mechanisms/server-flow.test.ts` |
| Complete shipped Task lifecycle | `examples/ai_hot_analysis/` | `tests/examples/ai-hot-analysis-example.test.ts` |

## 5. Completion checks

The refactor is complete only when all of the following pass from the repository root:

```bash
npm run typecheck
npm run build
npm test
npm run smoke
npm run pack
```

The final audit also checks:

- no dynamic Graph text appears in a role Prompt;
- no role Agent or Worker receives Graph or SQLite handles;
- role catalogs have the required visibility and fields;
- every output contract rejects prose, fences, missing required fields, and unknown fields;
- `src/`, `tests/`, and `examples/` contain no Chinese source text;
- each Project contains one `analysis.db`, `logs/`, canonical context/output artifacts, and `main.log` only;
- SQLite contains no Federation or execution-state tables.
