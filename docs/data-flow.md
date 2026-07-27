# Peak Data Flow

## Project

```text
POST /api/projects
-> projects/<uuid>/analysis.db
-> origin Fact from task.target
-> goal Fact from task.goal
```

## Plan

```text
GET Project Graph over HTTP
+ pending Federation FactRefs
+ POST /api/fact-refs/resolve
-> logs/graph-<timestamp>-plan.yaml
-> Worker strict JSON
-> POST Intent(s) | POST complete | noop
```

## Supervise

```text
poll active Graph
-> logs/graph-<timestamp>-supervise.yaml
-> Worker hint | noop
-> POST /hints
-> new Hint triggers Plan
```

Supervise cannot create Facts/Intents or complete/reopen a Project.

## Web UI

```text
GET /
-> live Project list
-> Fact nodes + Intent edges + independent Hint nodes
-> POST /api/projects/<id>/hints with creator human:web (configurable in UI)
-> active Project observes the new Hint on the next scheduler tick
```

The dashboard is available before bearer authentication so a browser can load it; all `/api` requests remain protected. `peak run` keeps the HTTP server and scheduler alive after a Project stops or completes, allowing inspection, Hint entry, status changes, and explicit reopen until `SIGINT`/`SIGTERM`. `peak serve` provides the same persistent Graph UI/API without workers.

## Execute

```text
open Intent + resolved source Facts
-> logs/graph-<timestamp>-execute.yaml
-> Worker fact JSON
-> optional workspace file streamed to POST /artifacts
-> POST /intents/<id>/conclude
-> one immutable local Fact
-> FederationBus.publish(FactRef)
```

A malformed or timed-out Execute can resume the same worker session once through Finalize. Pi sessions are retained in memory by the Agent SDK; CLI workers use their native session reference. Finalize writes its own Graph YAML and returns the same Fact contract.

## Artifact

```text
Worker workspace file
-> GraphClient streaming upload
-> Server SHA-256
-> artifacts/<sha256>
-> artifacts metadata row
-> facts.artifact_sha256
```

Artifact is optional supplemental Fact content. Fact description is always required.

## Federation

```text
source FactRef
-> source main.log send_fact_reference
-> in-memory FederationBus
-> target Plan context
-> target Graph write succeeds
-> target main.log receive_fact_reference
-> handled
```

Only FactRef is persisted in target `intent_sources`. Source Fact and Artifact remain in the source Project. FederationBus has no database.

## Completion

```text
POST /complete
-> validate local/cross-Project FactRefs and scope
-> create completion Intent to current goal
-> mark current Project completed in one transaction
-> cancel remaining in-memory executions
```

Completion is Project-local and immediate. Only explicit `/reopen` resumes it.
