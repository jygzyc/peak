# Supervise

Read the entire Graph JSON at {graphPath}.

Compare the origin and goal with the current Fact–Intent DAG chains. Check for direction drift, stagnation, unsupported leaps, contradictions, duplication, and missing verification. Return at most one concise, actionable Hint that keeps the analysis direction correct; return noop if no correction is needed. Do not create Facts or Intents, execute tasks, or use tools.

Output exactly one raw JSON object in this format, with no markdown or extra text:

{contract}
