/**
 * Vulnerability-hunting acceptance test (decx app-vulnhunt methodology).
 *
 * Validates that Peak's generic planner/explorer/evaluator loop can carry a
 * real domain workflow — Android APK attack-surface collection → control-flow
 * tracing → evidence-gated promotion — end to end, using only builtin prompts
 * plus inline domain knowledge. Peak's Fact model is domain-agnostic (no
 * structured `kind` field), so the 6-kind evidence taxonomy lives entirely in
 * the injected knowledge prose and fact descriptions; this test confirms the
 * mechanism still drives correct accept/reject/promote decisions.
 *
 * Source of the methodology: E:\Code\decx skills/decx-app-vulnhunt + the
 * android-app-analysis knowledge base (composite-chain matrix, 6-kind evidence
 * gate, severity table, rejection rules).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env, PROMPTS_DIR } from "./helper.ts";
import { join } from "node:path";

// ─── Domain knowledge (adapted from decx, inline) ──────────────────────────

const APP_VULNHUNT_KNOWLEDGE = `Android App Vulnerability Routing.

Exploitability gate: a finding needs all four — reachable entry, attacker-controlled security input, deep trace to sink or blocker, and visible impact. Missing one means candidate or dead end, not finding.

Composite chains first:
- Exported entry -> object/key mismatch -> intent redirect -> private component
- Parcelable/Serializable -> role/package/path confusion -> protected sink
- Provider leak/traversal -> URI grant/result leak -> private data
- WebView/deep link -> JS bridge -> native sink
- Mutable PendingIntent/fill-in -> victim identity action
- Broadcast/service command -> protected action -> result/reply leak
- Task/window embedding -> intent or result sniffing

High-signal single-pattern routing:
- Intent redirect: forwarded Intent/Uri/ClipData/selector/component/package/flags
- Provider leak: exported provider returns protected data, builds SQL, proxies attacker URI
- WebView: URL validation bypass, bridge exposure, file/content access, intent-scheme launch
- PendingIntent: mutable/fill-in/replayable dispatched as victim app
- Broadcast/service: dynamic receiver, ordered broadcast, weak permission, AIDL

Attack-surface collection priority: exported components (Activity/Service/Receiver/Provider), deep links, AIDL, dynamic receivers, WebView bridges, PendingIntent flows, broadcasts, cross-app channels.`;

const EVIDENCE_GATE = `Evidence and Rating Gate.

Promote only if all four are proven with concrete evidence:
1. Reachable: attacker can trigger the path.
2. Controllable: attacker controls the security-relevant field or object.
3. Deeply traced: value is followed through helpers, IPC, component/WebView/Binder boundaries to sink or blocker.
4. Impactful: attacker gains or changes something security-relevant.

Six required evidence kinds: entrypoint, reachability, control, guard, sink, impact.

Severity: CRITICAL (remote code execution, persistent compromise) / HIGH (data disclosure, credential theft, code execution in app process) / MEDIUM (bounded impact requiring local app or interaction) / LOW (fragile UI/recon impact) / IGNORED (unreachable, crash-only, no visible impact).

Rejection rules: reject when the exact sink path is rebuilt from trusted constants, dangerous fields are stripped, non-bypassable guard covers the exact method, write-only state has no readback, path is normalized and confined, or impact is only crash/compatibility. Reject facts with inline-only evidence and no manifest/source trace.`;

// ─── Task config: builtin prompts + inline domain knowledge ────────────────

function vulnhuntConfig() {
  const config = minimalConfig();
  config.profiles.planner.prompt = {
    file: join(PROMPTS_DIR, "planner.md"),
    knowledge: [APP_VULNHUNT_KNOWLEDGE],
    instructions: "Collect the attack surface first, then decompose along composite chains into bounded intents. Fail intents whose evidence the evaluator rejects.",
  };
  config.profiles.explorer.prompt = {
    file: join(PROMPTS_DIR, "explorer.md"),
    knowledge: [APP_VULNHUNT_KNOWLEDGE],
    instructions: "Probe-first: inspect manifest, exported components, deep links before reading source. Cite concrete evidence (manifest line, source location) in every fact.",
  };
  config.profiles.evaluator.prompt = {
    file: join(PROMPTS_DIR, "evaluator.md"),
    knowledge: [EVIDENCE_GATE],
    instructions: "Apply the four-element gate (reachable/controllable/deeply-traced/impactful) and reject facts with inline-only evidence.",
  };
  return config;
}

// ─── Helpers for envelope responses ────────────────────────────────────────

function decisions(createIntents: unknown[], failIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents, consumeHints: [], concludeRun });
}

/** Evidence block of the candidate under review (everything after "Evidence:").
 * Used so the evaluator decision keys on the *candidate*, not on prior verified
 * facts that also appear in the evidence-only view's prompt history. */
function candidateEvidence(prompt: string): string {
  const block = prompt.split("## Candidate Fact Under Review")[1] ?? "";
  return block.split("Evidence:")[1] ?? "";
}

// ─── Acceptance test ───────────────────────────────────────────────────────

test("acceptance: app-vulnhunt — attack-surface collection → trace → evidence-gated promotion", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = vulnhuntConfig();
  const p = createProject(graph, { target: "target.apk", goal: "prove exploitable APK attack paths" });

  // Explorer + evaluator entries are registered FIRST. The stateful planner is
  // registered LAST so it sits at the front of the match list (register()
  // prepends) and wins for planner prompts — otherwise the planner prompt (which
  // echoes intent descriptions under the "full" view) would be matched by the
  // explorer regexes and return a wrong envelope kind.

  // Explorers — attack-surface collection (well-evidenced entries) + one weak.
  worker.register(/COLLECT-SURFACE-A/i, env("fact", {
    description: "entrypoint: exported Activity com.app.DeepLinkActivity receives external Intent extra url (manifest: android:exported=true)",
    evidence: ["AndroidManifest.xml: <activity android:exported='true'>", "onCreate: getIntent().getStringExtra(\"url\")"],
    confidence: 0.8,
  }));
  worker.register(/COLLECT-SURFACE-B/i, env("fact", {
    description: "entrypoint: AIDL service may be reachable (unconfirmed)",
    evidence: ["inline speculation: no manifest/source checked"],
    confidence: 0.4,
  }));
  worker.register(/COLLECT-SURFACE-C/i, env("fact", {
    description: "entrypoint: deep link scheme app://open routes to DeepLinkActivity (manifest intent-filter)",
    evidence: ["AndroidManifest.xml: <intent-filter><scheme>app</scheme>"],
    confidence: 0.75,
  }));
  // Explorer — downstream trace along the composite chain.
  worker.register(/TRACE-CONTROL-SINK/i, env("fact", {
    description: "control+sink+guard: unvalidated url extra flows to WebView.loadUrl() with no guard — XSS / file-read primitive",
    evidence: ["DeepLinkActivity.onCreate -> handleUrl(url) -> mWebView.loadUrl(url)", "no input validation between extra and sink"],
    confidence: 0.85,
  }));

  // Evaluator gate: accept facts backed by manifest/source trace, reject those
  // with inline-only evidence. Decision keys on the candidate's own evidence
  // block so previously-verified facts in the view history do not skew it.
  worker.register(/Evaluator Role/i, (req) => {
    const ev = candidateEvidence(req.prompt);
    const hasConcrete = /manifest|source|->|onCreate|xref|intent-filter/i.test(ev);
    const isInlineOnly = /inline speculation/i.test(ev);
    if (isInlineOnly || !hasConcrete) {
      return env("verdict", { decision: "deny", reason: "inline-only evidence, no manifest/source trace — violates evidence gate" });
    }
    return env("verdict", { decision: "pass", reason: "concrete manifest/source trace supports reachable, controllable, traced path" });
  });

  // Stateful planner (registered LAST → highest match priority for planner prompts).
  // With replan-on-verdict (accept OR reject), the planner runs multiple rounds.
  // The response function can inspect the graph (via closure) so it only fails
  // an intent once its candidate has actually been rejected, and opens the trace
  // intent only once (avoiding duplicate work on each re-plan).
  //   round 1 (empty): open three attack-surface-collection intents
  //   round 2+ (verdicts seen): open the trace intent (once), fail rejected
  //     intents, then conclude once no new work remains.
  let plannerRound = 0;
  let traceOpened = false;
  worker.register(/automated planning module/i, () => {
    plannerRound++;
    if (plannerRound === 1) {
      return decisions([
        { description: "COLLECT-SURFACE-A: enumerate exported components", from: [], priority: 1 },
        { description: "COLLECT-SURFACE-B: enumerate AIDL services", from: [], priority: 1 },
        { description: "COLLECT-SURFACE-C: enumerate deep links", from: [], priority: 1 },
      ]);
    }
    const createIntents = traceOpened ? [] : [{ description: "TRACE-CONTROL-SINK: follow the url extra through control flow to its sink", from: [], priority: 1 }];
    if (!traceOpened) traceOpened = true;
    // Fail the AIDL intent only after its evidence was actually rejected.
    const denyFacts = graph.facts(p.id, "deny");
    const failIntents = denyFacts.some((f) => /AIDL service/i.test(f.description))
      ? [{ intentId: "i002", reason: "evaluator rejected: inline-only evidence" }]
      : [];
    // Conclude once the trace chain is verified and no new intent is pending.
    const verifiedDescs = graph.facts(p.id, "pass").map((f) => f.description);
    const traceProven = verifiedDescs.some((d) => /control\+sink\+guard/i.test(d));
    const concludeRun = (traceOpened && traceProven && createIntents.length === 0 && failIntents.length === 0)
      ? { description: "attack surface exhausted: entrypoint + trace chain proven" }
      : null;
    return decisions(createIntents, failIntents, concludeRun);
  });

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { idlePollMs: 5 });

  // ── Acceptance criteria ──────────────────────────────────────────────────

  // 1. The run completes.
  assert.equal(result.type, "completed", "vulnhunt run should complete");
  assert.equal(graph.getProject(p.id)!.status, "completed");

  const verified = graph.facts(p.id, "pass");
  const rejected = graph.facts(p.id, "deny");
  const allIntents = graph.intents(p.id);
  const descs = verified.map((f) => f.description);

  // 2. The entrypoint fact(s) AND the control/sink/guard trace fact are verified.
  assert.ok(descs.some((d) => /entrypoint.*DeepLinkActivity/i.test(d)), "an entrypoint fact for DeepLinkActivity should be verified");
  assert.ok(descs.some((d) => /control\+sink\+guard/i.test(d)), "a control/sink/guard chain fact should be verified");

  // 3. The speculative (inline-only) fact was rejected — the evidence gate fires.
  assert.ok(
    rejected.some((f) => /AIDL service may be reachable/i.test(f.description)),
    "the weakly-evidenced AIDL fact should be rejected by the gate",
  );

  // 4. No fact below the 0.5 confidence band slipped into verified.
  for (const f of verified) {
    assert.ok(f.confidence >= 0.5, `verified fact should meet confidence band: ${f.description} (got ${f.confidence})`);
  }

  // 5. The rejected path's intent was failed by the planner in response.
  const failedByPlanner = allIntents.find((i) => i.status === "deny" && i.killedBy === "planner");
  assert.ok(failedByPlanner, "the evaluator-rejected intent should be failed (killedBy=planner)");
});
