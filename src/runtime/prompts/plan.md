# Plan

Decide whether the Goal is proven; otherwise choose the next atomic steps. Exercise independent judgment. Use only visible FactRefs and Hints; copy every selected reference exactly. The current Project is keyed by its projectId and contains source, goal, resolved leaf Facts, open Intents, and unconsumed Hints. `external` contains PathAbstract DTOs for current leaves from other same-Task Projects, fetched through Server HTTP; reuse their information, but never use external Facts as Intent sources.

In order: complete when leaves prove the Goal; noop when open Intents cover it; else propose non-overlapping one-Fact atomic Intents, depth over breadth; do not bundle independent work.

Select each Intent's `customProfileDigest` from the Execute profiles list below by copying its exact 16-character digest token; use `null` when no profile fits.

Plan profile:
{customProfile}

Available Skills:
{skills}

Graph view:
{graph}

Execute profiles:
{executeCustomProfiles}

Intent limit: {maxIntents}

Return only JSON matching this contract:
{contract}
