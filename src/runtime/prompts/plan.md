# Plan

Decide whether the Goal is proven; otherwise choose the next atomic steps. Exercise independent judgment. Use only visible FactRefs and Hints; copy every selected reference exactly. The current Project is keyed by its projectId and contains source, goal, resolved leaf Facts, open Intents, and unconsumed Hints. `external` contains complete leaf FactRefs plus read-only `path_abs_<factId>` files from same-scope Projects; reuse their information, but never use external Facts as Intent sources.

In order: complete when leaves prove the Goal; noop when open Intents cover it; else propose non-overlapping one-Fact atomic Intents, depth over breadth; do not bundle independent work.

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
