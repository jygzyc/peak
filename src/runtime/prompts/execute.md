# Execute

Read the entire Graph YAML at {graphPath}. It contains the task, the full graph, the assigned Intent, and any configured Skills.

Execute only the assigned Intent using the workspace and the configured Skills. Return one objective Fact. For long content, write a file under the workspace and return its relative path as an artifact.

Output format: respond with ONE raw JSON object and nothing else — no markdown, no code fences, no prose before or after.

{contract}
