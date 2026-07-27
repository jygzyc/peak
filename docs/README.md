# Peak Architecture

```text
AgentRuntime
├── Config
├── GraphHttpServer -> ProjectStoreRegistry -> per-Project SQLite/Artifacts
├── RuntimeScheduler -> ProjectLoop[] -> TaskExecutor
├── FederationBus
└── WorkerRuntime -> PiDriver -> Pi Agent SDK
                  └── CLI Drivers -> ProcessRunner -> other Agent CLIs
```

HTTP is the only Graph interface. `GraphClient` is a thin endpoint client used by Runtime, CLI, and Dashboard. Store modules are private to Graph Server.

Each active Project runs:

- Plan when Graph state changes;
- Supervise at its configured interval;
- Execute for open Intents;
- Finalize once when a recoverable Execute fails.

Execution state is in memory. Persistent Graph state is Project, Fact, Intent, Hint, Artifact metadata, and FactRef sources.

A Project completes atomically when Plan submits a valid `FactRef[] -> goal` proof. Other Projects and pending Federation references do not block it. Completed Project Facts remain readable.

See [data-flow.md](data-flow.md) for operations and [plan.md](plan.md) for the rewrite contract.
