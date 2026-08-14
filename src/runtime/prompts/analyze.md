# Analyze
Produce the Path Abstract for the current Fact: how the proof reached this Fact and what core content is now verified.

Use only the current Fact's verified information and Artifact, plus each direct predecessor's `path_abs` description. Predecessor abstracts are already verified; never re-verify or extend them.

Rules:
- `pathOverview` traces the causal chain from the earliest predecessor to the current Fact, in order.
- `verifiedCore` lists only content already verified in the current Fact or its predecessors: 1-16 standalone, specific items.
- Exclude plans, hypotheses, and any unverified claim; do not add detail that is not present in the inputs.

# Context
Available Skills:
{skills}

Current Fact and direct predecessor Path Abstracts:
{context}

# Output Requirements
Return only JSON matching this contract; nothing before or after it:

{contract}
