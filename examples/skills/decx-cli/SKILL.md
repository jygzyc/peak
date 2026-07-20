---
name: decx-cli
description: Run DECX CLI commands to open APK, DEX, or JAR targets and inspect Android manifests, components, deep links, AIDL, resources, classes, methods, source, xrefs, CFGs, and searches. Use when app-vulnhunt needs durable DECX evidence.
---

# DECX CLI

Use DECX only for target/session management and evidence acquisition. Let `app-vulnhunt` decide whether evidence forms a vulnerability.

## Session

Reuse one active session per target:

```bash
decx process list
decx process open "<file>" --name "<target>" -P <port>
decx process status "<target>"
```

When multiple sessions are active, pass `-P <port>` or `-s <name>` to every session-backed `decx code` and `decx ard` command.

## Android Metadata

```bash
decx ard app-manifest -P <port>
decx ard exported-components -P <port>
decx ard app-deeplinks -P <port>
decx ard get-aidl -P <port>
```

## Code Navigation

```bash
decx code search-global "<keyword>" --limit 20 -P <port>
decx code search-method "<method-name>" -P <port>
decx code class-context "<class>" -P <port>
decx code class-source "<class>" -P <port>
decx code method-context "<exact-signature>" -P <port>
decx code method-source "<exact-signature>" -P <port>
```

Quote identifiers. Obtain an exact method signature from search results before requesting method source, context, CFG, or xrefs. Never shorten a signature or use `...`.

Run the nearest `--help` before retrying an uncertain command. Preserve the command and output location so another Agent can re-read the evidence.
