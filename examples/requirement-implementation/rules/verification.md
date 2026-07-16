# Implementation verification rules

- Cite the exact changed file and exported symbol.
- Verify every requirement, including invalid input and edge cases.
- Reject a candidate if the file is unchanged, only a plan was produced, or
  claimed tests do not execute the resulting artifact.
- EndFact may reference only the evaluator-accepted implementation Fact.
