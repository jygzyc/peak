# Report Contract

Use only when the assigned Intent requests a report from one or more confirmed vulnerability `pass` Facts.

## Finding Intake

For every finding:

1. Re-read the confirmed Fact, parent Intent/Facts, evaluator reason, and every evidence artifact.
2. Reconstruct the continuous entrypoint-to-impact chain.
3. Stop and return a blocker when the chain or an artifact is missing, unreadable, inconsistent, or no longer supports the claim.
4. Build one issue model. Do not render directly from scattered notes.

The issue model must contain:

```text
findingId
title
target and session
prerequisites
entrypoint and exact trigger
reachability
attacker control
guard outcome
sink and controlled argument
visible impact
evidence references
chain confidence
severity and rationale
composition
remediation
residual work
PoC/runtime state
```

Do not invent a missing trigger, guard, sink, impact, composition, severity rationale, evidence path, or PoC state.

## Rendering

Render the formats requested by the task. If none are specified, create:

- `report.zh.md`
- `report.en.md`
- `report.html`

Derive every format from the same issue models. Keep finding IDs, technical claims, evidence, severity, remediation, and PoC/runtime state identical across formats.

Each finding must include:

1. target context and prerequisites;
2. concise vulnerability summary;
3. numbered attacker-to-impact chain with evidence references;
4. six-part vulnerability decision and confidence;
5. visible impact, severity rationale, and uncertainties;
6. composition analysis;
7. remediation at the failed trust boundary and one regression condition.

For composition, state exactly one of:

- `composed`: name the related confirmed Facts and the supported combined chain;
- `not composed`: name the checked relation and the evidenced blocker.

Unresolved Intents and `candidate`/`pending` Facts may appear only under residual work. They are not findings.

## Completion

Return a candidate Fact that identifies the generated report paths and source finding IDs. Do not claim `poc-validated` or `runtime-validated` unless a separate PoC Intent produced re-readable build/runtime evidence.
