---
name: ai-agent-safety
description: Domain brief for AI safety research and AI Agent guardrail design.
---

# AI Agent Safety — Domain Brief

## Current AI safety landscape (treat 2024–2026 as "current")

- **Alignment & interpretability:** steering, oversight, scalable oversight, deceptive alignment, mechanistic / behavioral interpretability.
- **Agent security:** prompt injection (direct & indirect), tool and data exfiltration, privilege escalation, jailbreaks, agent supply-chain attacks.
- **Evaluation & red-teaming:** automated red-team, capability elicitation, refusal / over-refusal, sandboxed evals.
- **Incidents:** disclosed model and agent failures, attack write-ups, postmortems.
- **Standards & policy:** NIST AI RMF / AISI, EU AI Act + GPAI Code of Practice, ISO/IEC 42000, frontier-model frameworks.

## Source quality

Primary first: papers, official standards / regulator texts, vendor and advisory security docs, postmortems, maintained open-source repos. Reposts, listicles, and marketing are leads only — chase the primary source before trusting a claim.

## Designing an actionable guardrail architecture

A guardrail design is not a checklist — every control must map to a threat:

- Start with a **threat model**: assets, trust boundaries, actors, abuse cases, risk ranking.
- Cover the layers: identity / auth / delegation · tool & data boundaries (least privilege, secrets) · sandboxing / isolation (network, filesystem, process) · policy gates & budgets · runtime telemetry / anomaly detection · audit · incident response.
- For each control state the failure mode it blocks, an owner, the telemetry that proves it works, and an acceptance test.
- Keep preventive, detective, responsive, and recovery controls distinct.
