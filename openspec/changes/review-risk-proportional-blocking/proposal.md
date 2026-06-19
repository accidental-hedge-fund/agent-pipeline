## Why

The adversarial review round (`review-2`) blocks with a single global stance —
"assume the change can fail until the evidence says otherwise" — that is not
scaled to the change's actual stakes. So it churns even on changes the standard
round (`review-1`) already cleared as low-risk.

Evidence:

- **#186** (`pipeline doctor` stale-install check): `review-1` **approved with 0
  findings and rated the change low-risk**, then `review-2` blocked it for **6
  rounds** on medium `package.json`-hardening edge cases — each a new variant of
  the same theme. It converged only after repeated human nudges.
- Across 23 adversarial rounds on 5 recent issues, **0 LOW findings were ever
  emitted and ~84% were MEDIUM** — the reviewer floors at the blocking severity
  regardless of stakes.

This is the clearest case of miscalibrated rigor: a low-risk diagnostics change
consumed ~6 human-gated rounds for findings the standard round had already judged
immaterial. The fix is to make `review-2` block **in proportion to the change's
risk**, using `review-1`'s own assessment as the input — never independent risk
scoring, and never blocking *less* than the configured threshold for higher-risk
changes.

## What Changes

- **Capture `review-1`'s risk signal.** When the `review-1` comment is posted,
  the review stage emits a structured risk sentinel
  (`<!-- pipeline-review1-risk: low|standard -->`) derived purely from the
  structured verdict: **low** when `review-1` returned `approve` with zero
  findings, **standard** otherwise. The signal is a controlled marker the
  pipeline emits and reads — never parsed from the reviewer's free-text summary
  (prose-keying is adversarially unwinnable, per the #106 detector failure).
- **Propagate the signal into `review-2`.** When `review-2` runs (`round === 2`),
  the stage reads the `review-1` risk sentinel back from the issue comments
  alongside the existing `review1Summary` extraction. An absent or unrecognized
  sentinel defaults to **standard** (conservative — full configured threshold).
- **Scale the `review-2` blocking threshold by risk.** A new
  `review_policy.risk_proportional` flag (default `false`) gates the behavior.
  When `true` **and** the captured `review-1` risk is **low**, `review-2`
  partitions findings against an **effective threshold** equal to the stricter of
  the configured `block_threshold` and `high` — so only **high/critical** findings
  block and medium/low become advisory. For any higher-risk change, or when the
  flag is `false`, `review-2` uses the configured `block_threshold` unchanged. The
  `min_confidence` floor is never relaxed.
- **Config + docs.** `review_policy.risk_proportional` is added to the config
  schema (default `false`), documented in the `.github/pipeline.yml` reference,
  and registered in `RIGOR_GATING_PATHS` so a rename cannot silently orphan it.

The mechanism reuses the existing partition gate: only the `ReviewPolicy` handed
to `partitionFindings` changes for `review-2`; `partitionFindings` itself is
untouched.

## Acceptance Criteria

- [ ] The `review-1` verdict's risk signal — **low** (approve with 0 findings) vs.
      **standard** — is captured as a structured sentinel on the `review-1`
      comment and is readable by the `review-2` round.
- [ ] When the captured `review-1` risk is **low** and `risk_proportional` is on,
      `review-2` blocks only on findings of severity **high or critical**; medium
      and low findings are recorded as advisory and do **not** route to a fix
      round.
- [ ] When `review-1` was **not** low-risk (it surfaced findings), `review-2`
      uses the configured `block_threshold` unchanged.
- [ ] The behavior is gated by `review_policy.risk_proportional` (default
      `false`); with the flag off, `review-2` blocking is byte-for-byte the
      current behavior.
- [ ] For a higher-risk change the effective threshold is never *higher* (never
      blocks less) than the configured `block_threshold`; for a low-risk change
      the effective threshold is never *higher* than `high` and never *lower*
      (stricter) than the configured threshold.
- [ ] `review_policy.risk_proportional` is documented in `.github/pipeline.yml`
      and present in `RIGOR_GATING_PATHS`.
- [ ] Regression tests prove: (a) low-risk `review-1` + medium `review-2` finding
      + flag on → advances as advisory; (b) higher-risk `review-1` + medium
      `review-2` finding → still blocks; (c) flag off + low-risk + medium finding
      → still blocks; (d) low-risk + high `review-2` finding → still blocks.

## Scope

In scope: capturing `review-1`'s structured risk signal, propagating it to
`review-2`, the effective-threshold computation, the `risk_proportional` config
key, and its documentation/registration. The `min_confidence` floor and the
`block_threshold`/`max_adversarial_rounds` semantics are unchanged.

## Out of Scope

- Changing the severity rubric itself or adding a non-blocking emission flag
  (tracked separately; the `blocking: false` marker already shipped in #236).
- The global `block_threshold` / `min_confidence` values (already tightened to
  `high` / `0.85` in #231).
- Risk scoring independent of the standard review's own assessment — risk is
  derived solely from `review-1`'s structured verdict.
- Adding a structured `risk` tier field to the verdict schema — considered and
  deferred (see `design.md`); the `approve`-with-0-findings signal is the exact
  #186 evidence and needs no schema/drift-guard surface.

## Capabilities

### New Capabilities

- `review-risk-proportional-blocking`: `review-2` scales its effective blocking
  threshold by the `review-1` risk tier, gated by `review_policy.risk_proportional`.

### Modified Capabilities

- `review-layer`: the `review-1` comment carries a structured risk sentinel, and
  `review-2` routing consults it when `risk_proportional` is on.
- `pipeline-configuration`: a new optional `review_policy.risk_proportional`
  boolean (default `false`), registered in `RIGOR_GATING_PATHS`.

## Impact

- `core/scripts/types.ts` — `review_policy.risk_proportional: boolean` added to
  the config type and `DEFAULT_CONFIG`.
- `core/scripts/config.ts` — schema field (default `false`), resolution, and a
  `RIGOR_GATING_PATHS` entry.
- `core/scripts/review-policy.ts` — an `effectiveReviewPolicy(...)` helper that
  returns the risk-scaled policy; `partitionFindings` itself unchanged.
- `core/scripts/stages/review.ts` — emit the risk sentinel on the `review-1`
  comment; extract it at `review-2` time; hand the effective policy to the gate.
- `core/test/` — regression tests for the four cases above plus the sentinel
  round-trip and the effective-threshold helper.
- `.github/pipeline.yml` — documented `risk_proportional` line under
  `review_policy`.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).
