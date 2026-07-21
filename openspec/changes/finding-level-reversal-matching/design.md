## Context

`partitionFindings(findings, policy, overrides, scopes, nonReproducing, reviewedSha, settledSurfaces)`
demotes an otherwise-blocking finding to advisory with reason `reversal-unacknowledged` when
`surfaceKey(f) ∈ settledSurfaces` and `prior_round_acknowledgment` is blank
(`core/scripts/review-policy.ts`). `surfaceKey` is `normalize(file) | category` — deliberately
coarse (#234), because surface clustering was designed to detect *streaks* on a file, not to
identify a finding. Reusing it as the reversal identity is the defect: it makes "same file, same
category" mean "same finding".

## Goals / Non-Goals

**Goals**
- A demotion fires only when the new finding is plausibly the *same* finding a prior round settled.
- The decision is pure, deterministic, and explainable in the audit trail.
- #389's convergence guarantee survives: a genuine re-flip of a settled trade-off is still demoted,
  including when the fix moved the code (different line band) or the reviewer restated the severity.

**Non-Goals**
- No LLM-based or embedding-based similarity: the guard runs inside a pure partition function with
  no I/O, and a nondeterministic guard cannot be drift-guarded by a unit test.
- No change to digest derivation, the `blockingFindings` artifact extension, or the
  `prior_round_acknowledgment` schema field.
- No loosening of `review_policy`; this change only narrows an over-broad demotion.

## Decisions

### 1. The guard's input becomes settled *findings*, not settled surfaces

`review-history.ts` already carries per-finding identity in the digest (`key`, `surface`,
`severity`, `title`). Expose `settledFindings(digest): SettledFinding[]` where each entry is
`{ key, surface, title, round }`, keeping the existing "most recent resolution is `resolved-by-fix`
or `overridden`" definition of settled but retaining it **per finding** instead of collapsing to
its surface. `settledSurfaceRounds` / `settledSurfaces` are superseded by this accessor for the
guard's purposes.

*Alternative rejected*: keep the surface set and add an escape hatch (e.g. only demote when
severity also matches). It still conflates distinct findings that happen to share severity, and it
leaves the audit trail unable to name which prior finding was settled — an explicit acceptance
criterion of #464.

### 2. Re-raise match rule

`isReRaise(finding, settled)` is true iff **both**:

1. `surfaceKey(finding) !== null` and equals `settled.surface` — the surface remains a necessary
   pre-filter, never a sufficient condition. When `settled.surface` is `null` (legacy
   blocking-keys-only comments), fall back to key equality alone.
2. `findingKey(finding) === settled.key` **or** `titleSimilarity(finding.title, settled.title) >= 0.6`.

`titleSimilarity` is the Jaccard index over lower-cased, punctuation-stripped, stopword-filtered
token sets. Chosen over exact-title equality because a fix round routinely shifts a finding's line
band (changing `findingKey`) and the reviewer restates the title in its own words; chosen over
substring/prefix matching because it is symmetric and insensitive to word order. `0.6` is a fixed
exported constant so the threshold is testable and reviewable rather than a magic literal. The
#395 pair scores far below it ("captured artifacts are not actually PR-visible" vs "artifact copy
errors are not reported"); a genuine restatement scores far above.

### 3. Fail open toward rigor

If no settled entry matches, the finding is partitioned by `review_policy` alone — i.e. it blocks.
This is the direction golden rule 3 requires: a missed demotion costs one extra fix round, a false
demotion ships an unfixed HIGH finding. Consequently a settled entry recovered without a title
(rendered `(title unavailable)`) contributes only its key to matching: it can match by key, never
by similarity. Entries with an empty/placeholder title are excluded from the similarity branch
explicitly rather than being allowed to score against an empty token set.

### 4. Audit trail names the matched finding

The demotion record carried into rendering becomes
`{ settledKey, settledTitle, settlingRound, matchedBy: "key" | "title-similarity" }`, so the
comment tag reads `REVERSAL-UNACKNOWLEDGED: re-raises <settledKey> "<title>" settled in round N`
and the `reversal_unacknowledged` event gains `settled_finding_key` and `matched_by` alongside the
existing `finding_key`, `surface`, and `settling_round`. Existing event consumers ignore unknown
fields; no field is removed.

### 5. Prompt wording

`review_adversarial.md`'s digest framing and the rendered digest currently speak of "re-raising a
settled **surface**". Both change to "settled **finding**", so the reviewer's instruction for when
`prior_round_acknowledgment` is required matches what the guard actually enforces. This keeps the
prompt/behavior pair honest and is covered by the existing `prompt-loader.test.ts` drift guards.

## Risks / Trade-offs

- **Under-demotion on heavy rewording.** A reviewer that re-raises a settled trade-off in wholly
  different words at a new line band escapes the guard and blocks. Accepted: it produces a fix
  round, not a silent ship, and the digest still shows the reviewer the settled constraint.
- **Threshold tuning.** `0.6` is a judgement call; it is exported and unit-tested at both ends
  (the #395 pair below, a restatement above) so a future adjustment is a one-line, test-visible
  change.
- **Call-site churn.** `partitionFindings`'s seventh parameter changes type. All callers are
  in-repo (`stages/review-routing.ts`, `stages/pre_merge.ts`, tests); the parameter keeps a default
  of `[]` so "no digest supplied → unchanged partitioning" still holds.

## Migration

None at runtime. Digest comments already on open PRs are read unchanged; the guard simply becomes
stricter about what counts as a re-raise. Issues currently parked with a wrongly-demoted finding
re-block on their next review round, which is the intended correction.
