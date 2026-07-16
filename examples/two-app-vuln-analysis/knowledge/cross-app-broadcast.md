# Cross-App broadcast analysis knowledge

A cross-App vulnerability chain must distinguish the two trust boundaries.

1. Sender evidence must prove a sensitive value enters an implicit broadcast
   without a package restriction or receiver permission.
2. Receiver evidence must prove the action is externally receivable and trace
   the broadcast extra to a security-relevant sink.
3. A sibling FactBroadcast is an untrusted reference until the local evaluator
   assesses it. It can satisfy a named pending condition but cannot become a
   local pass Fact directly.
4. The final severity requires a concrete end-to-end impact, not merely two
   apps using the same action string.
