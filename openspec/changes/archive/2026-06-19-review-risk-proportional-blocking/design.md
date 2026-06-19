## Context

Review runs as two rounds: `review-1` (standard) then `review-2` (adversarial),
both through `advanceReview` in `core/scripts/stages/review.ts`. The blocking
decision is a single gate: `partitionFindings(verdict.findings, cfg.review_policy,
overrides, scopes)` (`review-policy.ts`) splits findings into `blocking` /
`advisory` / `overridden` using `policy.block_threshold` (severity rank) and
`policy.min_confidence`. When `blocking` is empty the item advances with an
audited record; otherwise it routes to the matching fix round.

`review-1` already produces a risk signal: the standard prompt instructs the
reviewer to open `summary` with `Risk: <tier> — <reason>`. But that lives in
free-text prose, and this repo's hard-won rule (the #106 spec-divergence detector
failure) is that gates MUST key on structured fields, never on keyword-matched
prose. So we cannot route `review-2` off the `Risk:` summary string.

The review stage already passes context between rounds: at `round === 2` it calls
`extractReview1Summary(detail.comments)` and threads `priorReview2Findings`. The
codebase has an established **HTML-comment sentinel** pattern for exactly this —
`extractReviewedSha`, `extractDiffHashFromComment`, `extractBlockingKeysMarker`,
the `pipeline-override` / `pipeline-override-scope` sentinels — each emitted by
the pipeline and read back by an `extract*` function.

## Goals / Non-Goals

**Goals**
- Make `review-2` block in proportion to `review-1`'s own risk assessment.
- Key the decision on a **structured** signal, not the reviewer's prose summary.
- Keep the change root-cause-minimal: reuse `partitionFindings` unchanged; only
  the policy handed to it for `review-2` changes.
- Default-off; flag-off behavior is byte-for-byte identical to today.

**Non-Goals**
- Adding a `risk` field to the verdict schema (see the decision below).
- Touching `min_confidence`, `block_threshold`, or `max_adversarial_rounds`
  semantics.
- Independent/external risk scoring — risk derives solely from `review-1`.

## Decisions

### Decision: derive the `review-1` risk tier structurally, not from a new schema field

The risk signal is **low** when `review-1` returned `verdict: "approve"` with
**zero findings**, and **standard** otherwise. This is computed at
comment-format time from the already-parsed `ReviewVerdict` — no reviewer
cooperation beyond the verdict it already emits.

Two binary tiers (`low` | `standard`) are sufficient for the issue: the feature
only relaxes `review-2` when `review-1` was *maximally clean*; every other case
keeps the configured threshold. This is exactly the #186 evidence — `review-1`
"approved with 0 findings."

*Alternative considered — a structured `risk: "low"|"medium"|"high"` field on the
verdict.* Rejected for this change: it expands `review-schema.ts`, both prompt
schema blocks, the field guards, and the drift-guard test; and it invites the
reviewer to *floor* the risk field the same way it already floors severity at
MEDIUM (the very pathology this issue documents). The structural
`approve`-with-0-findings signal cannot be gamed that way and matches the
acceptance evidence directly. A richer tiered field can be a separate follow-up
if multi-tier proportionality is ever needed.

*Alternative considered — parse `Risk: low` from the `review-1` `summary`.*
Rejected: prose-keying is the adversarially-unwinnable anti-pattern this repo
fixed in #106. The sentinel is the controlled, structured equivalent.

### Decision: carry the signal as an HTML-comment sentinel on the `review-1` comment

`formatReviewComment` (or the review stage around it) appends
`<!-- pipeline-review1-risk: low -->` or `<!-- pipeline-review1-risk: standard -->`
to the `review-1` comment, mirroring the existing sentinel pattern. At
`round === 2`, a new `extractReview1Risk(comments)` reads the latest such
sentinel. **Fail-safe default:** when no recognized sentinel is found (legacy
comments, parse failure), the risk is treated as **standard**, so `review-2`
falls back to the full configured threshold — never a looser one.

### Decision: scale via an effective `ReviewPolicy`, leaving `partitionFindings` untouched

A pure helper `effectiveReviewPolicy(policy, { round, review1Risk })` returns the
policy to hand to `partitionFindings`:

- `round !== 2` → `policy` unchanged (only `review-2` scales).
- `!policy.risk_proportional` → `policy` unchanged (flag off ⇒ current behavior).
- `review1Risk !== "low"` → `policy` unchanged (higher-risk ⇒ configured
  threshold; "never blocks less than configured").
- `review1Risk === "low"` → a clone whose `block_threshold` is the **stricter
  (higher-ranked)** of the configured `block_threshold` and `"high"`:
  `low/medium → high`, `high → high`, `critical → critical`. `min_confidence` is
  copied unchanged.

Using `max(rank(configured), rank("high"))` (not a flat assignment to `"high"`)
preserves the safe floor in both directions: a low-risk change can never block
*more* than the configured threshold (a `critical` config stays `critical`), and
can never block *less* than `high` (only high/critical ever block). The review
stage computes `effectiveReviewPolicy(...)` once and passes the result into the
existing `partitionFindings(verdict.findings, effectivePolicy, overrides, scopes)`
call site. No new branching inside the partition logic.

### Decision: `risk_proportional` defaults to `false` and is a rigor-gating path

Default `false` keeps every existing run identical. Because turning it on *reduces*
`review-2` blocking for low-risk changes, it changes review coverage and must be
registered in `RIGOR_GATING_PATHS` (`config.ts`) so the schema-coherence test
catches any future rename — consistent with how `block_threshold` /
`min_confidence` / `max_adversarial_rounds` are already tracked.

## Risks / Trade-offs

- *A genuinely risky change that `review-1` happened to approve with 0 findings
  would get the relaxed `review-2` threshold.* This is bounded: high/critical
  findings still block under the effective threshold, and `min_confidence` is
  unchanged. The premise of the two-round design is that `review-1` is a
  competent first pass; if it approved with zero findings, treating the change as
  low-risk for `review-2`'s medium/low bar is the intended trade and is opt-in.
- *Binary tiers ignore the prompt's three-way `Risk:` self-report.* Accepted for
  minimality; the binary signal covers the documented failure and avoids the
  schema/floor risks of a structured tier field.
- *Legacy `review-1` comments lack the sentinel.* Handled by the **standard**
  fail-safe default — older or unparseable comments simply keep the full
  configured threshold.
