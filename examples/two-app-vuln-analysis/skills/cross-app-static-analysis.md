# Skill: static cross-App Intent tracing

1. Analyze only the app assigned to the current session.
2. Record action names, permissions, package restrictions, exported state and
   the exact sensitive extra at every Intent boundary.
3. Keep conclusions that depend on the sibling app pending with one explicit
   required condition.
4. Treat federation material as a reference; never copy it into a local Fact.
5. Produce one atomic candidate Fact per Intent with repository-relative
   evidence.
