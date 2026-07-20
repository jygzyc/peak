---
name: app-vulnhunt
description: Analyze authorized Android APK attack surfaces with DECX, prove or reject attacker-to-impact chains, review confirmed Peak pass Facts, write evidence-bound vulnerability reports, and prepare or validate one minimal PoC per confirmed finding. Use for exported components, deep links, Providers, Services, broadcasts, Binder or Messenger IPC, WebViews, URI grants, PendingIntents, untrusted object parsing, external files, dynamic loading, and composed cross-app chains.
---

# Android App Vulnerability Hunt

Prove a concrete path from an attacker-controlled entrypoint to a visible security impact. Treat DECX output as evidence, never as a vulnerability verdict.

Operate only on applications, devices, accounts, and data the user is authorized to test.

## Routing Gate

Choose exactly one mode from the assigned Intent:

| Mode | Required input | Required result |
| --- | --- | --- |
| Hunt | One APK/session and one bounded security question | One candidate Fact proving or blocking that question |
| Report | One or more confirmed vulnerability `pass` Facts | Evidence-bound report artifacts and one candidate Fact referencing them |
| PoC | Exactly one confirmed vulnerability `pass` Fact | One complete PoC spec and one minimal build-ready PoC; runtime work only when explicitly requested |

Do not use this Skill for Android framework/service-framework analysis, generic DECX command help, or unauthorised exploitation. Use the separately loaded `decx-cli` Skill for DECX command syntax and session management.

## Non-Negotiable Rules

- Do not call exported status, a dangerous API, a manifest flag, or a crash a vulnerability by itself.
- Do not bridge an unproven call hop, callback, IPC boundary, identity transition, guard, or sink argument with an assumption.
- Do not produce a report or PoC from a `candidate`, `pending`, or `deny` Fact.
- Do not create DECX graph nodes, promotion nodes, leases, findings, reports, or PoCs. Peak owns Fact/Intent task state; the Agent only returns its contract result and writes requested artifacts.
- Do not mutate or reinterpret a confirmed finding during report or PoC work. Return a blocker when its evidence is incomplete or unreadable.
- Produce one bounded candidate Fact for the assigned Intent. Keep discovery, confirmation, report generation, PoC construction, and runtime validation as distinct Intents and artifacts.

## Load Bundled References

Load only the references required by the selected mode:

| Situation | Reference |
| --- | --- |
| Route an observed source, boundary, or sink | [Attack Routing](references/attack-routing.md) |
| Decide `pass`, `pending`, or `deny`; assign confidence or severity | [Vulnerability Decision](references/vulnerability-decision.md) |
| Consume confirmed Facts and write reports | [Report Contract](references/report-contract.md) |
| Consume one confirmed Fact and create or validate a PoC | [PoC Contract](references/poc-contract.md) |

For Hunt mode, read Attack Routing first and Vulnerability Decision before returning the result. Do not load sibling routes merely because the same Android component type appears.

## Peak Role Boundary

- **Planner**: create atomic Intents for attack-surface collection and missing chain elements. Do not inspect source, execute DECX commands, or decide evidence validity.
- **Explorer**: execute exactly one claimed Intent, acquire re-readable evidence, write any requested workspace artifact, and return one candidate Fact. Do not broaden the assignment into a full hunt.
- **Evaluator**: independently re-read cited evidence and return `pass`, `pending`, or `deny`. Do not investigate a new route or repair missing proof.
- **Metacog**: inspect overall coverage, duplicate/dead routes, evidence quality, and completion readiness; emit corrective Hints only.

## Hunt Workflow

1. Identify the externally reachable surface relevant to the assigned question.
2. Select the smallest plausible chain based on observed behavior, not an API or component name.
3. State the exact missing element: entrypoint, reachability, control, guard, sink, or impact.
4. Trace the same attacker-controlled value or object through every transformation and boundary.
5. Stop at the first proven blocker; record it instead of searching for a way around an unrelated guard.
6. Preserve re-readable evidence for each proven hop.
7. Return one candidate Fact that states only the strongest supported conclusion and explicitly names any missing proof.

### Attack-Surface Record

For each relevant entrypoint, record:

- external actor and channel;
- component/class and exact handler;
- exported state or trigger condition;
- permission, protection level, caller, package, signature, origin, or user-interaction requirements;
- exact trigger syntax;
- attacker-controlled fields or objects;
- first security-relevant operation and guard.

Inspect only surfaces present in the target: exported Activities/Services/Receivers/Providers, aliases and intent filters; deep links and custom schemes; Binder/AIDL/Messenger and dynamic receivers; Provider CRUD/call/batch/file paths; WebView navigation and bridges; nested or implicit Intents, results, `ClipData`, selectors, flags, URI grants, and PendingIntents; Parcelable/Serializable/Bundle/JSON/URI/path/archive parsing; external storage, update/plugin/DEX/native loading; and cross-app channels such as shares, clipboard, notifications, accessibility, or AccountManager.

### Deep-Trace Record

For the security-relevant value, record:

1. its exact attacker-controlled origin and field;
2. parsing, normalization, copying, defaulting, reconstruction, and key/object substitutions;
3. helpers, callbacks, threads, lifecycle transitions, serialization, Binder/AIDL/Messenger, component launches, Provider internals, WebView/JavaScript, redirects, result callbacks, URI grants, reflection, and dynamic dispatch crossed by the value;
4. every permission, identity, signature, package, target, URI, origin, path, integrity, sanitizer, or confirmation guard;
5. whether each guard holds, is absent, or is bypassed for that same value;
6. the exact sink operation and controlled argument;
7. the concrete confidentiality, integrity, authorization, execution, or meaningful availability consequence.

## Evidence Contract

Evidence must be independently re-readable. Record the DECX command, target session, exact class/method/field or manifest/resource location, and durable output/artifact reference. Copy exact method signatures from DECX results; do not shorten them or use placeholders.

A complete vulnerability chain must support all six elements:

```text
entrypoint -> reachability -> control -> guard -> sink -> impact
```

When any element is missing, return the strongest narrower Fact and name the smallest evidence request that could resolve it. Apply the verdict, confidence, false-positive, and severity rules in Vulnerability Decision.

## Downstream Work

Before Report or PoC mode, re-read the confirmed `pass` Fact, its parent Intent/Facts, and every referenced artifact. Stop if the entry-to-impact chain, exact trigger, guard outcome, sink, visible impact, or evidence provenance is absent.

- In Report mode, follow Report Contract and keep all formats derived from one issue model.
- In PoC mode, follow PoC Contract, complete the spec before creating code, and default to build-ready without claiming compilation or runtime success.

## Output Discipline

- Cite durable evidence and generated artifact paths.
- Distinguish observed facts from bounded inferences and unresolved conditions.
- Never claim report generation, build, install, launch, exploitation, or runtime validation without the corresponding artifact or command result.
- Keep PoCs minimal, reversible, non-persistent, and restricted to the authorized finding.
