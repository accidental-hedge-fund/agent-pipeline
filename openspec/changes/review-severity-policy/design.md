## Context

Verdict routing in `advanceReview` (`core/scripts/stages/review.ts`) was binary: `approve` → advance,
`needs-attention` → fix (or block on zero findings). `ReviewFinding` already carries a typed `severity`
(`critical`|`high`|`medium`|`low`) and a numeric `confidence`, but neither informed routing. The
SHA gate (`review-sha-gating`) re-runs review on every HEAD change, so a finding the reviewer keeps
re-emitting — whether out-of-scope or an outright false-positive — has no termination path.

## Goals

- A repo can declare a severity/confidence threshold below which findings advise rather than block.
- A human can disposition one specific blocking finding as an audited event, after which it no longer
  blocks — giving the pipeline a convergence escape hatch.
- Default behavior is unchanged (every finding blocks).

## Decision 1: Threshold + confidence floor in a `review_policy` config section

`review_policy: { block_threshold, min_confidence }`, mirroring the existing `test_gate` / `eval_gate`
sections (zod-validated, strict, merged in `resolveConfig`). A finding blocks when its severity rank is
`>= block_threshold` **and** its confidence is `>= min_confidence`. Default `block_threshold: "low"`,
`min_confidence: 0` makes every finding block. Unknown severities rank as `medium` so a garbled value
never silently downgrades to non-blocking.

**Alternative considered**: a fixed built-in policy (e.g. "high+ blocks"). Rejected — repos differ in
risk tolerance; config keeps the default safe and the opt-in explicit, matching `eval_gate`.

## Decision 2: All-advisory verdict advances instead of routing to fix

When a `needs-attention` verdict's findings are all advisory/overridden, the review still ran and its
findings are recorded; the item advances to the next stage (review-2 or pre-merge) with an audited
"advanced under severity policy" comment. The SHA sentinel on the review comment keeps the pre-merge
gate consistent. This is what lets a false-positive/out-of-scope finding stop blocking convergence.

## Decision 3: Content-addressed finding keys + `pipeline-override` sentinel

Each finding gets a stable key `sha1(severity|file|title)[:8]`, surfaced in the review comment so a
human can reference it. `--override "<key>: <reason>"` posts an audited comment carrying a
`<!-- pipeline-override: <key> <disposition> -->` sentinel (mirroring the `reviewed-sha` precedent).
The gate reads active overrides (last wins) and excludes matched findings from blocking. The key is
content-addressed — not positional — so a re-emitted finding on a later commit keeps the same key and
the prior override keeps applying across rounds.

**Alternative considered**: override by finding index. Rejected — indices shift between reviews; a
content hash is stable across re-reviews, which is exactly the recurring-finding case this targets.

## Risks

- A mis-set low threshold could advise away a real bug. Mitigation: default is the safest setting
  (everything blocks); opt-in is explicit and per-repo; advisory findings remain visible on the PR.
- Overrides are powerful. Mitigation: every override is a recorded comment (who via GitHub authorship,
  why in the body, what via the key) — auditable, never a silent pass.
