---
name: daily-ai-hotspots
description: Collect, verify, deduplicate, rank, and summarize AI developments published on the current calendar day. Guides Plan (proof structure), Execute (immutable Facts), and Supervise (coverage Hints).
---

# Daily AI Hotspots

This Skill drives a Project whose `origin` is "today's AI developments are uncollected" and whose `goal` is "an evidence-backed daily digest". The runtime has three operations; apply this Skill to all of them:

- **Plan** decides proof structure: create sweep Intents, then per-event verification Intents, then prove the Goal.
- **Execute** resolves exactly one Intent into one immutable Fact.
- **Supervise** reviews the whole Graph and adds at most one Hint about coverage gaps.

Facts are immutable and objective. There is no candidate/pass/deny state and no separate evaluator. A weak or rejected lead is still a valid Fact that *describes the obstacle*; later Facts can correct or supersede earlier ones by referencing them as sources.

## Time Boundary

- Resolve the runtime date and cutoff in `Asia/Shanghai` (`UTC+08:00`) before searching.
- Search a wider UTC window if needed, but admit an event only if its authoritative publication or material update falls within that local calendar day.
- Record timestamps exactly as displayed, then state the converted local time. If a source exposes only a date, preserve that precision and never invent a time.
- Keep publication time, event time, and discovery time separate.
- Treat the result as a partial-day digest when the cutoff precedes the end of the day.

## Source Policy

Prefer sources in this order:

1. Original announcements from AI labs, companies, standards bodies, regulators, conference organizers, or project maintainers.
2. Primary records: papers, official repositories/releases, model or dataset cards, filings, regulatory documents.
3. Independent reporting with named sources and direct attribution.

Aggregators, search snippets, newsletters, reposts, engagement counts, and social posts are discovery aids only. Link to the canonical page, not a search result. For a claim without an available primary record, require two independent reputable reports and disclose the limitation.

## Plan Methodology

Plan only restructures the Graph; it never searches or writes a Fact.

1. **Empty Graph** (only `origin` exists): create one sweep Intent per source category, each sourced from `origin`:
   - product / company / funding
   - research / models / datasets / benchmarks
   - policy / regulation / safety
   Create at most `tasks.plan.maxIntents` Intents in one Plan pass (default 3). Use descriptions like "Sweep product/company AI news for <date>".
2. **After sweep Facts exist**: for each promising lead in those inventories, create one verification Intent sourced from the producing sweep Fact (and `origin` if you need independence). One event per Intent.
3. **When coverage is sufficient**: submit `complete` with the Goal-proof `description` being the digest summary, and `from` being the verified Facts you rank. Do not wait for every lead if the day is quiet; a digest with 1-3 strong items plus an exclusions note is a valid completion.

Plan never references another Project's `goal`, and every `from` Fact must already exist and be visible in the Graph YAML.

## Execute Methodology

Execute resolves one Intent. Return one objective Fact. Two shapes:

### Sweep Fact

A bounded lead inventory, not a ranking. The Fact `description` (<= 16 KiB) must state:

- local date and cutoff;
- source categories actually checked;
- up to eight distinct leads, each with a stable event key `organization-or-project/action/object/date`, a one-line claim, the direct URL, publisher, visible timestamp, and source tier;
- leads marked unclear, inaccessible, conflicting, or likely duplicate.

### Verification Fact

Exactly one event. The Fact `description` must contain:

- local date and cutoff;
- concise headline and category;
- stable event key;
- what happened (supported claims only);
- why it matters;
- total significance score with per-dimension rationale;
- publication precision and local-time conversion;
- uncertainty or conflicts;
- evidence entries: source tier, publisher, visible timestamp, canonical URL, supported claim.

An out-of-date, duplicate, inaccessible, or weak event is a valid bounded result: describe the obstacle instead of inflating it.

If the full evidence or a long digest would exceed the description limit, write a Markdown file under the workspace (e.g. `reports/<event-key>.md`) and return it as an `artifact` with `mediaType: "text/markdown"`. The `description` must still stand on its own; the Artifact only holds the detail.

## Significance Score

Score each dimension 0-3 (max 12):

| Dimension | Question |
| --- | --- |
| Novelty | Is there a concrete new release, result, decision, or event? |
| Reach | How broadly can it affect users, developers, researchers, or markets? |
| Consequence | Does it materially change capability, access, cost, safety, policy, or competition? |
| Evidence strength | How direct, specific, and independently supported is the record? |

A ranked hotspot normally requires at least 7. Popularity alone does not raise the score. Do not force a category quota or minimum item count.

## Supervise Methodology

Read the whole Graph. Add at most one Hint (or `noop`) targeting the most impactful gap:

- an unchecked source category with no sweep Fact;
- duplicate event keys across Facts that Plan has not merged;
- a stale cutoff or date that no longer matches the current local day;
- a verification Fact missing direct-source evidence;
- a quiet Graph where Plan has not yet created the next Intents.

Never create Facts/Intents or judge completion. One Hint per pass; if the top issue is already an existing Hint, return `noop`.

## Digest & Completion

When Plan submits `complete`:

- `description` is the digest: date, cutoff, timezone, coverage scope, then ranked items (headline, category, what happened, why it matters, direct URLs, publication precision, score, uncertainty), then an excluded/unresolved note.
- `from` is the set of verification Facts being ranked (and optionally the sweep Facts that sourced them).
- Rank only verified, non-duplicate Facts at or above the threshold. Explain close ordering with concrete consequences.
- Keep claims attributed. Avoid "breakthrough", "first", or "best" unless evidence establishes them.
- A quiet day may yield fewer than three items; say so explicitly rather than padding.
