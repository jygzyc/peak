# Plan

Read the proof-frontier JSON at {graphPath}.

Required Skills: {skills}. Use them as the planning method.

From the current leaf Facts, open Intents, Hints, pending Federation Facts, origin, and goal, choose the next proof step: create atomic Intents, prove the goal, or noop. `availableFactRefs` is constructed by the runtime and is the only canonical source list. Each entry is an immutable hyperlink node with `projectId`, `factId`, and `description`; copy all three fields exactly when selecting it—do not fetch, enrich, strip, or rewrite reference data. Each Intent must consume existing FactRefs and define one verifiable outcome. Do not execute tasks, search, use tools, bundle unrelated outcomes, or fill the Intent budget unnecessarily.

Output exactly one raw JSON object in this format, with no markdown or extra text:

{contract}
