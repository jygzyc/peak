# Verification Fact — Kimi K3 Open-Weight Release (Scheduled 2026-07-27)

## Scope

- **Local date**: 2026-07-27 (Asia/Shanghai, UTC+08:00)
- **Cutoff (verification time)**: 2026-07-27 12:58 Asia/Shanghai (2026-07-27 04:58 UTC)
- **Categories checked**: product/company/funding, research/models/datasets/benchmarks, policy/regulation/safety (sweep)
- **Intent**: i002 (verify candidate against primary source)

## Headline

Moonshot AI's Kimi K3 — the first open 3T-class model — has its full open weights scheduled for public release on 2026-07-27 under a Modified MIT license. As of verification time (12:58 Asia/Shanghai), the release had not yet occurred; the official Hugging Face model page showed an "Upcoming release" countdown with ~10 hours remaining, indicating a target release around 23:00 Asia/Shanghai (15:00 UTC) the same calendar day.

## Stable Event Key

`moonshot-ai/kimi-k3/open-weights/2026-07-27`

## Category

Research / models / datasets / benchmarks (open-weight frontier release).

## What Happened (verified)

1. **2026-07-16**: Moonshot AI publicly announced Kimi K3 on `kimi.com/blog/kimi-k3`. The model launched on Kimi.com, Kimi Work, Kimi Code, and the Kimi API; weights were promised "by July 27, 2026."
2. **Model characteristics** (from primary blog):
   - 2.8 trillion parameters — first open 3T-class model.
   - Architecture: Kimi Delta Attention (KDA) + Attention Residuals (AttnRes); Stable LatentMoE activating 16 of 896 experts.
   - Native vision, 1M-token context window.
   - MXFP4 weights / MXFP8 activations; quantization-aware training from SFT stage.
3. **2026-07-27 (verification day)**:
   - Hugging Face canonical page `huggingface.co/moonshotai/Kimi-K3` displays an "Upcoming release" status with a live countdown ("00 days · 10 hours · 01 min" at fetch time 04:58 UTC) and an "Expected release July 27, 2026" line.
   - The Moonshot AI org page on Hugging Face (`huggingface.co/moonshotai`) does NOT list Kimi-K3 in its 18 public models as of verification time; newest listed is `moonshotai/Kimi-K2.7-Code` (updated 2026-06-15).
   - A third-party Hugging Face Space (`lyffseba/xai`) tracks status as "kimi-k3, Kimi K3, API live · weights pending, 2.8T, undisclosed, 1M, 16/896".
   - Multiple derivative repositories (e.g., `audnai/penclaw-Kimi-K3.0-abliterated-GGUF`) are staged in pending state with future-tense wording ("When the K3.0 weights are released on July 27, 2026, this repository will contain…").

## Why It Matters

- **Open-weight frontier shift**: At 2.8T parameters, K3 would be the largest openly available model, extending the open frontier that Kimi has anchored for 9 of the past 12 months per the primary blog.
- **Competitive positioning**: K3's launch-era benchmarks (per Moonshot's blog) place it near Claude Fable 5 and GPT-5.6 Sol on long-horizon coding and agentic benchmarks while remaining behind on overall UX. Open weights let any party self-host near-frontier capability.
- **Geopolitical dimension**: Release occurs amid active US-China AI chip export controls; an open-weight drop sidesteps hardware restrictions on capabilities, since 1.4 TB of weights is globally redistributable.
- **Ecosystem / commercial**: Aligned with Moonshot's reported Hong Kong IPO timing (ARR ≈ $300M in June 2026 per third-party reporting) and with partners (Microsoft, NVIDIA, AMD, vLLM) preparing infrastructure.
- **License**: Modified MIT permits commercial use with restrictions on military use and attribution — more permissive than Llama licenses.

## Significance Score

Total: **10 / 12**

| Dimension | Score | Rationale |
| --- | --- | --- |
| Novelty | 3 | First open 3T-class model; new KDA/AttnRes architecture; concrete scheduled material release today. |
| Reach | 3 | Global open-source AI community, inference vendors, enterprises, regulators; ~1,235 waitlist on HF at fetch time. |
| Consequence | 3 | Materially shifts open-weight frontier; affects OpenAI/Anthropic/Meta competitive landscape; intersects US export-control policy. |
| Evidence strength | 1 | Strong primary record for the announcement (2026-07-16) and the deadline commitment, but the TODAY release itself is not yet verifiable at cutoff; one LinkedIn premature claim is contradicted by the canonical HF page. |

## Publication Precision and Local-Time Conversion

| Marker | Source | Precision | Local (Asia/Shanghai) |
| --- | --- | --- | --- |
| Initial announcement | `kimi.com/blog/kimi-k3` | date only (2026-07-16) | 2026-07-16 (date) |
| Verification fetch time | runtime | second-accurate (UTC) | 2026-07-27 12:58 |
| HF countdown at fetch | `huggingface.co/moonshotai/Kimi-K3` | minute-accurate (~10h 01min remaining) | target ≈ 2026-07-27 23:00 |
| LinkedIn premature claim | Satyarth Priyedarshi post | "midnight UTC" assertion | asserted 2026-07-27 08:00 — contradicted |

No authoritative source exposes an exact minute for the planned weight drop. The HF countdown is the only quantitative primary signal; treat the target time as approximate.

## Uncertainty and Conflicts

- **Premature release claim**: A LinkedIn post by Satyarth Priyedarshi (visible timestamp "2h" before verification fetch ≈ 2026-07-27 03:00 UTC, 11:00 Asia/Shanghai) asserts "Kimi K3's 1.4TB open weights hit Hugging Face today … Moonshot AI released full Kimi K3 weights at midnight UTC." This is **contradicted** by:
  - The canonical Hugging Face model page showing "Upcoming release" with a live countdown at 04:58 UTC.
  - The Moonshot AI org page not listing K3 in its model catalog.
  - Multiple staged derivative HF repositories written in future tense.
  - Independent Space `lyffseba/xai` marking weights as "pending."
- **Cutoff caveat**: The "by July 27, 2026" deadline wording leaves open the possibility that the actual drop occurs later in the Asia/Shanghai day or slips past midnight. This Fact is a **partial-day** verification; later Intents should re-check before issuing the digest.
- **Original blog timing**: The 2026-07-16 launch blog does not expose an exact publication timestamp; precision is day-level.

## Evidence Entries

| # | Tier | Publisher | Visible Timestamp | Canonical URL | Supported Claim |
| --- | --- | --- | --- | --- | --- |
| 1 | Tier 1 (vendor primary) | Moonshot AI / Kimi | 2026-07-16 (date) | https://www.kimi.com/blog/kimi-k3 | K3 launch + weights promised "by July 27, 2026"; architecture and availability details. |
| 2 | Tier 2 (primary record) | Hugging Face (model page) | fetched 2026-07-27 04:58 UTC | https://huggingface.co/moonshotai/Kimi-K3 | "Upcoming release" status; countdown to 2026-07-27. |
| 3 | Tier 2 (primary record) | Hugging Face (org page) | fetched 2026-07-27 04:58 UTC | https://huggingface.co/moonshotai | Moonshot AI catalog does not include Kimi-K3 as of fetch. |
| 4 | Tier 2 (primary record) | vLLM (vendor blog) | 2026-07-22 (date) | https://vllm.ai/blog/2026-07-22-kimi-k3-preview | Production-scale K3 support preview; corroborates July 27 weight-drop deadline. |
| 5 | Tier 3 (independent reporting) | Windows Forum / TechTimes | 2026-07-24/25 | https://windowsforum.com/threads/kimi-k3-weights-arrive-july-27-new-coding-model-choice.439231/ ; https://www.techtimes.com/articles/321499/20260724/kimi-k3-open-weights-drop-july-27-near-frontier-coding-undisclosed-hallucination-risk.htm | Independent corroboration of deadline; notes weights not yet public as of 2026-07-24. |
| 6 | Tier 3 (social, contradicted) | Satyarth Priyedarshi (LinkedIn) | ≈ 2026-07-27 03:00 UTC | https://www.linkedin.com/posts/satyarth_kimi-k3s-14tb-open-weights-hit-hugging-activity-7487332410460798976-zuK0 | Premature claim of midnight-UTC release; contradicted by entries 2 and 3. |
| 7 | Tier 2 (community tracker) | HF Space `lyffseba/xai` | fetched 2026-07-27 | https://huggingface.co/spaces/lyffseba/xai | Tracks "kimi-k3 … weights pending". |

## Verdict

**Verified as scheduled but not yet executed at cutoff.** The development is real, primary-sourced, and bound to today's Asia/Shanghai calendar day per Moonshot's commitment. The actual weight-drop event has not been confirmed within the verification window. Re-verification is required before inclusion in the final digest as a completed hotspot; alternatively, the digest should explicitly label K3 as "scheduled for 2026-07-27, partial-day pending."

## Sources Consulted but Not Admitted (other 2026-07-27 candidates)

- **Apple WWDC27 / Apple Intelligence next-gen**: dated 2026-06, not today.
- **AMD Advancing AI 2026**: keynote 2026-07-23, not today.
- **WAIC 2026 Shanghai**: 2026-07-17 through 2026-07-20, not today.
- **Trump AI Executive Order**: 2026-07-13, not today.
- **OpenAI GPT-5.6 Sol**: 2026-06-27 launch, not today.
- **Mistral × Microsoft partnership expansion**: 2026-07-21, not today.
- **AI Funding week of Jul 20–26**: aggregated, no single 2026-07-27 announcement identified.
- **Amazon product-title policy (Jul 27)**: e-commerce rule, not AI.
- **Node.js security releases**: not AI.

No other AI development with a 2026-07-27 authoritative publication or material update was identified across the sweep.
