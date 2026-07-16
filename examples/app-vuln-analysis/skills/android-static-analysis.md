# Skill: Android static entry-to-impact tracing

1. Start from a bounded Intent and inspect the smallest relevant files.
2. Record the external entry and the exact attacker-controlled field.
3. Follow the value across helper calls and framework boundaries; record every guard transformation.
4. Identify the final sink and explain observable impact.
5. Produce one atomic candidate Fact. Do not create sibling tasks or mutate graph state directly.
6. When evidence is incomplete, describe the missing condition precisely so federation can later reactivate it.
