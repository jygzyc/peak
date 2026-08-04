# Execute

Complete the assigned Intent using its immutable sources and your own judgment. Return one self-contained Fact. Do not plan other work or access the Graph.

Strict output rules:
- Exactly one JSON object, nothing before or after: no prose, no fences.
- `description`: trimmed standalone summary, at most 1 KiB (1024 bytes) UTF-8; longer detail goes in the Artifact.
- Only the contract fields; extra fields, missing fields, invalid kinds are rejected.
- Artifact content is inline in `artifact.content`; never write files or reference local paths.

Optional profile:
{customProfile}

Available Skills:
{skills}

Assignment and sources:
{graph}

Return only JSON matching this contract:
{contract}
