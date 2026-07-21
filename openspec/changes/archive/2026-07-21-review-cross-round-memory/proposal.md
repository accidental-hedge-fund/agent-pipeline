## Why

Each review round today is context-free with respect to the rounds that came before it. Round N sees the issue, the plan, the diff, and (for an adversarial re-review) the immediately-prior round-2 findings — but it never sees **what trade-offs earlier rounds already settled and how**. The observed failure mode (castrecall #5, castrecall #61) is oscillation rather than convergence: round 2 demands a hard cap, the fix adds one and is accepted; round 3 then demands the cap be removed, having no idea a prior round asked for it. Nothing new is discovered, but the pipeline burns a fix cycle, a re-review, and eventually parks at `needs-human` on a contradiction it created itself.

The pipeline already persists everything needed to prevent this — per-round blocking keys, `(file|category)` surface keys, and `--override` dispositions all live durably in the pipeline-authored review comments on the PR. It simply never feeds any of it back to the reviewer.

## What Changes

- **A per-issue cross-round digest** is derived from the durable evidence already on the PR (prior rounds' review comments and override comments) and injected into every review round after the first: round-2 adversarial, adversarial re-reviews, and the pre-merge delta review. Round 1 (no prior rounds) renders an empty section, so single-round issues are byte-identical to today.
- The digest records, per prior round: each blocking finding's key, `(file|category)` surface, severity, and title; its **resolution** (`resolved-by-fix`, `overridden`, or `still-open`); and any `--override` disposition recorded in that round, attributed to that round. It carries **no diffs, transcripts, or prior prompts**, and is size-capped.
- **A settled-surface reversal guard.** A surface a prior round settled is marked as such in the digest. When round N raises a *blocking* finding on a settled surface, the reviewer MUST populate a new optional `prior_round_acknowledgment` finding field naming the prior round and why a third option is needed. An unacknowledged re-flip does not pass reversal validation: it is demoted to advisory, tagged in the review comment, and recorded as an event — it never silently blocks or silently disappears.
- The digest is reviewer-authored text, so it is wrapped in the same `<untrusted-external-evidence>` boundary the carry-forward brief uses and is sanitized before injection.
- The `ReviewArtifact` block gains an optional `blockingFindings` extension array (key, surface, severity, truncated title) so the digest is built from a structured record rather than scraped markdown; comments without it degrade to the existing `pipeline-blocking-keys` / `pipeline-blocking-surfaces` markers.

## Capabilities

### New Capabilities
- `review-cross-round-memory`: derivation, rendering, injection, and sanitization of the prior-round digest; the settled-surface reversal guard and its verdict-schema field.

### Modified Capabilities

_None._ The digest reads existing durable artifacts; the `ReviewArtifact` extension field is already permitted by `review-artifact-record` ("the implementation MAY add optional extension fields without breaking readers that ignore unknown fields"), and the reversal guard adds an optional schema field rather than changing `verdict-schema-single-source`'s existing requirements.

## Acceptance criteria

- [ ] For a review round N ≥ 2, the rendered prompt contains a digest section listing each prior round's blocking findings with, per finding, its key, surface, severity, title, and resolution (`resolved-by-fix` / `overridden` / `still-open`).
- [ ] The digest lists every `--override "<key>: <reason>"` disposition recovered from the PR's trusted override comments, each attributed to the round in which it was recorded.
- [ ] For round 1, or for any round with no recoverable prior round, the digest placeholder renders as the empty string and the resulting prompt is byte-identical to the prompt the same inputs produce today.
- [ ] A blocking finding whose surface matches a digest surface marked `settled` and whose `prior_round_acknowledgment` is absent or blank is demoted to advisory, tagged in the posted review comment, and emitted as an event; the same finding **with** a non-empty `prior_round_acknowledgment` blocks normally.
- [ ] The digest is built only from PR comment evidence and override comments — no run-local or in-memory state — so an identical digest is produced by a fresh process on a machine with no `.agent-pipeline/` directory.
- [ ] The rendered digest contains no diff hunks, harness transcripts, or prior prompt text, and is capped (per-round finding count and total characters) with an explicit truncation marker when the cap bites.
- [ ] A regression test replaying a castrecall-#5-style history (round 1: no cap; round 2: cap demanded and fixed; round 3: cap re-litigated) asserts the round-3 prompt contains the round-1 and round-2 positions marked as settled constraints.
- [ ] A regression test replaying a castrecall-#61-style history (401/403 semantics reversed across rounds) asserts the same behavior for that surface.
- [ ] The digest section is enclosed in `<untrusted-external-evidence>` tags with the no-instructions directive, and injection imperatives inside reviewer-authored titles/reasons are redacted.
- [ ] `npm run ci` passes, including the regenerated `plugin/` mirror and `openspec validate --all`.

## Impact

- **Code**: new `core/scripts/review-history.ts` (pure digest derivation + rendering); `core/scripts/prompts/index.ts` (`{{prior_rounds_digest}}` slot in `buildReviewAdversarialPrompt` and `buildDeltaReviewPrompt`); `core/scripts/prompts/review_adversarial.md`; `core/scripts/review-schema.ts` and `core/scripts/types.ts` (optional `prior_round_acknowledgment` field + drift guard); `core/scripts/review-policy.ts` (reversal demotion in `partitionFindings`); `core/scripts/stages/review-rendering.ts` (`blockingFindings` artifact extension, reversal tag); `core/scripts/stages/review.ts` and `stages/pre_merge.ts` (wire the digest in).
- **Tests**: `core/test/review-history.test.ts` plus the two named regression replays; drift-guard updates in `review-schema.test.ts` and `prompt-loader.test.ts`.
- **Generated**: `plugin/` mirror must be regenerated in the same change.
- **No config surface change** and no change to `review_policy` thresholds, the review-SHA gate, or the ceiling/recurrence guards.
