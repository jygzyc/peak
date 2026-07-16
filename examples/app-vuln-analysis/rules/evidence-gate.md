# Evidence gate

- Cite repository-relative file and symbol/line evidence for entry, control, guard, sink and impact.
- Explorer output is always a candidate Fact.
- Use `pending` only when a named, testable condition is missing. State that condition in `requiredConditions`.
- Reject speculation, crash-only behavior, unreachable code, or paths protected by a non-bypassable exact guard.
- A broadcast summary cannot be copied into a local Fact. It may only be assessed as relevant/irrelevant or used to reactivate an existing pending Fact.
- EndFact may reference only local pass Facts and may be created only after all local Intent/candidate work is terminal.
