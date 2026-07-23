## Why

A pre-merge delta review (#228) sees only the unreviewed commits since the last reviewed SHA. When
that delta is a narrow follow-up (an operator or fix commit addressing specific findings), the
reviewer has no way to check the state of the code the prior findings pointed at — so it re-asserts
those findings as blocking with the rationale "outside this delta's narrow fixes", even when the
file at HEAD already resolves them. Observed on #451 (run `451-2026-07-21T23-27-27-304Z`): the delta
at `7b5b945` re-raised `ac3bdbd2` / `4040cada` / `edfd3cf1` with claims directly contradicted by the
head code (engine-scoped discovery plus an existing host-crossing fixture; a repeated `--label`
already hard-rejected; `--range` already normalizing to the work-list), costing three audited
overrides.

The cross-round memory digest (#389/#464) already gives review rounds the prior-round history, and
it is already injected into the delta prompt — but it carries *keys, titles, and dispositions*, not
the file state needed to verify a claimed resolution. A reviewer that can only see a narrow diff
cannot falsify "this was never fixed", so it defaults to assuming persistence. The delta review
needs the resolution-verification equivalent: which prior blocking findings were resolved, plus
enough HEAD file state on their surfaces to check the resolution instead of assuming it.

## What Changes

- Derive a **resolved-finding verification context** for the pre-merge delta review from the
  existing prior-round digest: the prior blocking findings that are recorded as `resolved-by-fix`
  or `overridden`, with their finding key, surface (file + category), title, settling round, and
  disposition.
- Inject that context into the delta-review prompt as an explicit *verify-at-HEAD* instruction:
  a prior finding is presumed resolved; re-asserting it as blocking requires evidence read from the
  current file state, and "not addressed by this narrow delta" is explicitly not such evidence.
- Supply **HEAD file state** (not diff-only) for the files named by those settled findings'
  surfaces, read from the delta reviewer's worktree at the reviewed head, bounded by a per-file and
  total byte cap with truncation disclosed in the prompt.
- Demote to advisory any delta finding that re-asserts a settled finding's surface without citing
  HEAD-state evidence, reusing the #389 reversal-acknowledgment machinery and its comment/event
  disclosure rather than adding a second mechanism.
- Keep the whole block absent when there is no settled prior-blocking history (first delta round,
  fail-closed `actor: null` digest), so the existing delta path is byte-identical there.
- Pin a regression fixture replaying the #451 history (the three re-asserted keys, their surfaces,
  and the narrow delta) so the demotion and the injected context are drift-guarded.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `pre-merge-delta-recheck`: adds requirements for the delta review's resolved-finding verification
  context, HEAD file-state injection on settled surfaces, the evidence rule for re-asserting a
  settled finding, the no-history no-op, and the #451 regression fixture.

## Acceptance criteria

- [ ] The pre-merge delta-review prompt contains a resolved-finding section listing every prior
      blocking finding recorded as `resolved-by-fix` or `overridden` (key, surface, title, round,
      disposition) whenever the prior-round digest carries at least one such finding.
- [ ] That section instructs the reviewer that a settled finding is presumed resolved at HEAD, and
      that re-asserting it as blocking requires citing current file state — explicitly rejecting
      "outside this delta's narrow fixes" / "the delta does not address it" as sufficient grounds.
- [ ] The prompt carries the HEAD content of each distinct file named by a settled finding's
      surface, read from the delta reviewer's worktree, labelled with its path, and marked
      `(truncated)` when a per-file or total byte cap trims it.
- [ ] The injected file state and resolution context are sanitized and fenced as untrusted evidence
      on the same terms as the digest (no nested-fence escape, no directive smuggling).
- [ ] A delta finding whose surface matches a settled finding and whose body cites no HEAD-state
      evidence is partitioned as advisory, not blocking, and the demotion names the settled finding
      and its settling round in both the posted comment and the emitted run event.
- [ ] A delta finding on a settled surface that *does* cite current file state still blocks (the
      rule demotes unverified persistence claims, never genuine regressions).
- [ ] With an empty or history-free digest the delta prompt is unchanged from today's output and no
      file reads are performed.
- [ ] A regression fixture replaying the #451 delta (keys `ac3bdbd2`, `4040cada`, `edfd3cf1` on
      their recorded surfaces, resolved in prior rounds, re-asserted with narrow-delta rationale)
      demonstrates all three are demoted to advisory and the run needs no override; the test fails
      against the pre-change behavior.
- [ ] `npm run ci` passes from the repo root, including the regenerated `plugin/` mirror.

## Impact

- `core/scripts/review-history.ts` — derive the resolved/settled verification entries from the
  existing `PriorRoundDigest` (no new durable artifact, no new comment marker).
- `core/scripts/prompts/index.ts` (`buildDeltaReviewPrompt`) and `core/scripts/prompts/
  review_adversarial.md` — new rendered section and its placeholder.
- `core/scripts/stages/pre_merge.ts` — resolve the settled surfaces' HEAD file state from the delta
  worktree behind an injectable seam, and thread it into `runDeltaReview`.
- `core/scripts/review-policy.ts` — the evidence rule in the delta partition path.
- `core/test/` — prompt-loader drift guards plus the #451 regression fixture.
- No config keys, no CLI surface change, no change to the non-delta review path or the freeform
  (non-OpenSpec) path.
