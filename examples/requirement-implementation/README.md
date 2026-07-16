# Requirement implementation scenario

The fixture starts with an unimplemented `slugify` function. The task requires
the coding worker to modify the workspace, the evaluator to verify the changed
artifact, and the planner to create an EndFact only after the implementation
Fact passes. The acceptance test copies the fixture to a temporary workspace so
the repository input remains unchanged and executes the resulting module to
prove behavior rather than trusting a textual “done” response.
