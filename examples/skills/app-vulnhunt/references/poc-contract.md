# PoC Contract

Use only when the assigned Intent names exactly one confirmed vulnerability `pass` Fact. Default to `build-ready`; compile, install, launch, or interact with a device only when the task explicitly requests it.

## Finding Intake

Re-read the confirmed Fact, parent Intent/Facts, evaluator reason, and all evidence artifacts. Stop if the entry-to-impact path is missing or the PoC spec cannot be filled entirely from confirmed evidence.

## PoC Spec Gate

Complete this spec before creating code:

```yaml
findingId:
target:
sessionId:
entryFactId:
impactFactId:
trigger:
controllableInput:
guardOutcome:
sink:
impact:
successSignal:
requirements: []
pocShape:
supportComponents: []
exploitId:
```

Every field must come from confirmed Facts or re-readable evidence. Do not infer helper components, payload keys, target components, flags, acquisition steps, environment requirements, or success signals. One spec maps to one finding and one exploit ID.

## Shape Routing

Choose exactly one primary shape:

| Confirmed surface | PoC shape |
| --- | --- |
| exported Activity, result, task/UI/lifecycle | direct trigger, returned handle, or UI-assisted |
| Broadcast/Receiver | direct trigger or interception |
| Provider query/file/call/batch/grant | direct trigger or returned handle |
| Service/Messenger/AIDL | direct trigger or Binder caller |
| PendingIntent, URI grant, implicit Intent, parcel/class loader | returned handle, interception, or direct trigger |
| WebView/deep link/hosted payload | scenario page |

Implement only that shape. Replace every package, action, URI, extra, component, permission, and payload value with confirmed evidence. Add support components only when required by the spec.

Keep the PoC minimal, reversible, non-persistent, and limited to the authorized finding. Use harmless markers or reversible actions wherever they can prove the same security outcome.

## Build-Ready Output

Create source/project artifacts and document exact build and manual execution steps. Return:

```text
state=build-ready
projectPath
findingId
exploitId
trigger
successSignal
requirements
filesChanged
buildStatus=not-run
runtimeStatus=not-run
remainingManualSteps
```

Do not claim compilation, installation, launch, or exploitation.

## Explicit Runtime Validation

Only when explicitly requested:

1. record target build, device/API version, account/state, and environment requirements;
2. build and capture the real command, exit status, and output;
3. prove entrypoint reachability and controlled input delivery;
4. exercise the evidenced guard outcome;
5. trigger the sink and capture the exact success signal;
6. repeat from a clean state;
7. run a negative control with the critical input or condition removed.

Classify runtime state accurately:

- `confirmed`: expected impact is reproducible and the negative control does not produce it;
- `partially-confirmed`: reachability/control is observed but a boundary, guard, sink, or impact remains unproven;
- `not-reproduced`: expected impact does not occur under recorded conditions;
- `not-run`: no real execution occurred.

Do not convert `not-reproduced` directly to `deny` when environment uncertainty remains. Return a candidate Fact describing the observed contradiction, evidence, blocker, and smallest follow-up for Evaluator.
