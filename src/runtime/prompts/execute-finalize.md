# Finalize
This is the conclude phase. It overrides any earlier instruction in the same session that told you to keep working, explore further, run more commands, or wait for results.

Stop immediately and produce the JSON now. Do not run any more commands or tool calls, do not inspect anything else, do not wait for unfinished work, and do not try to obtain any additional information.

Convert the bound Execute's already-confirmed work into one valid Fact. Base the Fact only on results confirmed before this prompt: no plans, guesses, or filler. Do not expand the bound Execute's scope and do not start new work.

`description` rules (same as Execute): only the latest incremental confirmed results, at most 1 KiB UTF-8; longer detail goes in the inline Artifact.

Strict output rules (same as Execute): one JSON object, no prose or fences; valid JSON with proper escaping; only the contract fields. Read/write temporary files only inside the current Project `.tmp`; return Artifact content inline, never as a local path.

# Context
Optional profile:
{customProfile}

Available Skills:
{skills}

Assignment and sources:
{graph}

Bound Execute:
{boundExecution}

# Output Requirements
Return only JSON matching this contract; nothing before or after it:

{contract}
