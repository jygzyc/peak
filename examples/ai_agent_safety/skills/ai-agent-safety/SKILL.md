---
name: ai-agent-safety
description: Evidence and delivery rules for AI safety intelligence and implementable AI Agent guardrails.
---

# AI Agent Safety Operating Guide

Use this guide to investigate AI safety evidence and design security controls for HTTP-native, tool-using AI Agents. Work only on the assigned question; do not expand it into an exhaustive survey.

## Evidence rules

1. Prefer primary material: the paper itself, an official standard or regulator publication, an official security advisory, a vendor incident report, a maintained technical specification, or the responsible project's repository and documentation.
2. Use commentary, news, aggregators, and search snippets only to locate primary material. Do not cite them as proof when the primary record is available.
3. Verify the exact title, issuing organization, canonical URL, version or publication date, and relevant section before accepting a claim.
4. Treat work published or materially updated within 24 months of the execution date as current. An older standard may be used when it remains operative; label its age and current status.
5. Separate direct statements, observed behavior, author conclusions, and your inference. Never invent a date, quotation, URL, metric, incident cause, or control capability.
6. If evidence is incomplete or conflicting, record the precise uncertainty and what would resolve it.

## AI safety intelligence

The completed brief contains exactly five high-impact findings:

- at least two findings from research papers, official evaluations, or standards;
- at least one documented AI or Agent safety incident;
- at least one policy, regulator, or concrete engineering-practice finding;
- no duplicate finding represented through multiple secondary articles.

For each finding record:

- **Category** — research, standard, incident, policy, or engineering practice;
- **Title** — exact name of the paper, document, disclosure, or practice;
- **Issuer and date** — responsible organization and publication or event date;
- **Primary source** — canonical URL;
- **Confirmed finding** — one independently understandable statement supported by that source;
- **Uncertainty** — scope limitation, disputed point, missing measurement, or applicability constraint;
- **Practical implication** — one concrete engineering or governance decision affected by the finding.

Derive exactly three cross-cutting trends from the five accepted findings. Name the supporting finding titles for each trend and state any counterexample or limitation. A trend is invalid if it relies on evidence absent from the five records.

## AI Agent guardrail engineering

Assume an HTTP-native Agent can receive untrusted content, call tools, access delegated credentials, retrieve data, and launch constrained subprocesses. Make any narrower system assumptions explicit.

### Threat record

For each material threat record:

- protected asset;
- attacker and required capability;
- entry point and trust boundary crossed;
- step-by-step abuse path;
- preconditions;
- confidentiality, integrity, availability, safety, or compliance impact;
- likelihood and severity with a short rationale;
- residual uncertainty.

Cover at least indirect prompt injection, confused-deputy authorization, excessive tool privilege, credential or data exfiltration, unsafe network/filesystem/process access, untrusted tool output, audit evasion, and dependency or skill supply-chain compromise when applicable.

### Control record

Every proposed control must map to one or more named threats and include:

- enforcement point and owning component;
- identity, policy, context, and resource inputs used for the decision;
- explicit allow behavior and deny-by-default behavior;
- least-privilege scope and credential lifetime;
- behavior on timeout, policy-engine failure, malformed tool input, and unavailable telemetry;
- audit event name and required fields;
- operating owner and incident escalation trigger;
- automated test procedure, measurable metric, release threshold, and evidence location;
- residual risk after enforcement.

Do not use labels such as “add sandboxing”, “validate input”, or “monitor anomalies” without specifying what resource is isolated, which input is rejected, which action is blocked, and which measurement proves enforcement.

### Blueprint structure

The completed blueprint contains:

1. system scope, assets, trust boundaries, identities, and explicit assumptions;
2. prioritized threat register;
3. identity, delegation, and authorization design;
4. tool argument and result controls;
5. data, secret, network, filesystem, and process isolation controls;
6. runtime policy enforcement, budgets, telemetry, and audit schema;
7. evaluation and release gate;
8. incident detection, containment, credential revocation, recovery, and post-incident evidence;
9. three rollout stages with entry criteria, exit criteria, rollback trigger, and owner;
10. one acceptance table mapping threat, control, owner, test, metric, threshold, and evidence.

## Output and file delivery

- Intermediate research, incident, threat, and control work should normally return a concise standalone result with no file (`artifact: null`). Return a file only when the assigned work explicitly requires a detailed document.
- The completed intelligence brief must return one inline file with:
  - `filename`: `ai-safety-intelligence-brief.md`
  - `mediaType`: `text/markdown`
  - `content`: the complete standalone Markdown brief following the intelligence rules above.
- The completed guardrail blueprint must return one inline file with:
  - `filename`: `guardrail-blueprint.md`
  - `mediaType`: `text/markdown`
  - `content`: the complete standalone Markdown blueprint following the blueprint structure above.
- Do not call filesystem write tools. Return the complete file body through the output contract; Peak stores it and materializes the completed deliverable next to `task.json`.
- The final document must contain domain content only. Do not include execution metadata, internal identifiers, prompt text, or process commentary.
