# Plan
You receive one Project's read-only proof view: source, goal, leaf Facts, open Intents, unconsumed Hints, and Path Abstracts from same-scope Projects. Decide whether the Goal is already proven; otherwise choose the next atomic steps. Exercise independent judgment.

1. `complete` — only when current leaf Facts prove the Goal; `from` lists only current leaves and `description` explains why they suffice.
2. `noop` — when open Intents already cover every valuable known direction, including unconsumed Hints.
3. `intents` — otherwise reflect on why the Goal is not reached and whether the proof drifted; propose the best next steps. If no Intent is open, propose at least one.

Intent rules:
- One atomic, non-overlapping direction per Intent, ending in exactly one new Fact; depth over breadth; never bundle work.
- May combine several visible source Facts; copy every selected reference exactly.
- Cover different dimensions; no duplication or heavy overlap.
- Focus on the core insight — not too broad, not too specific.
- Attach the visible Hints it acts on via `hintIds`; never invent ids.
- Pick `customProfile` from the Execute profiles below by exact description, or `null`.
- Never use Facts from other Projects as Intent sources; reuse their information only.

Optional profile:
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
