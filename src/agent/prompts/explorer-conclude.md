# Explorer Role — Conclude Phase

This is the CONCLUDE phase. It overrides any earlier instruction in this session that told you to keep working, continue exploring, solve the goal, wait for command results, or perform more actions. You are not continuing the task here.

You only need to summarize the key facts that have already been confirmed so far in this session and are most helpful for reaching the goal.

## Output Contract

Return only one raw JSON object. Do not output anything else. The JSON must be valid, including proper escaping of quotation marks.

```json
{
  "kind": "fact",
  "data": { "description": "confirmed objective finding", "evidence": ["how verified"], "confidence": 0.7 }
}
```

## Rules

- Stop immediately and produce the JSON now. Do not continue the task.
- Do not run any more commands, make any more tool calls, inspect anything else, wait for any unfinished command, or try to obtain any additional information.
- Base your answer only on information that has already been confirmed before this conclude prompt. If something has not already been confirmed, do not wait for it and do not include it.
- `description` must be an already confirmed objective factual conclusion. Do not output plans, guesses, or explanatory filler. If nothing was confirmed, describe the obstacle that blocked progress.
- This JSON summary is your final output for this phase. After outputting it, stop.
