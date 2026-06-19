## Context

At the `max_adversarial_rounds` ceiling (`stages/review.ts`, the
`priorRoundComments.length + 1 >= roundCap` branch), the pipeline posts the
"Review ceiling reached" punch-list and transitions to `needs-human`. That park
is the only brake on the fix↔review loop. For low/medium-risk changes whose
remaining findings are all below high severity, the park is the wrong terminal —
a human has to override or fix immaterial nits before the item can move. This
change adds a configurable demote-and-advance terminal for exactly that case.

## Decisions

### Default `ceiling_action: park`

The flag defaults to `park` — today's hard-park behavior — for the same reason
`risk_proportional` defaulted to `false`: the pipeline's product is its review
rigor, and the project rule is to never *default*-demote review coverage to go
faster (CLAUDE.md golden rule #3). `demote_and_advance` is opt-in per repo. The
acceptance bar "the default preserves safety on irreversible-action surfaces" is
met by keeping the conservative park as the default; a repo that knows its surface
is reversible opts in.

### High/critical always park; only below-high demote

The cut is `severityRank(f.severity) >= severityRank("high")` — high and critical
stay blocking; medium and low are demotable. When **any** high/critical finding
remains at the ceiling, the item hard-parks at `needs-human` exactly as today,
*regardless of `ceiling_action`* and without demoting the lower findings (the
human owns the whole residual call in that case — partial advance would be
confusing). Demote-and-advance only fires when the remaining blocking set is
entirely below high. This keeps the safety-relevant path identical to today.

### Recurrence early-park is intentionally left as hard-park

`review-loop-recurrence`'s early park (a blocking finding re-emitted with an
unchanged `findingKey` after a fix round) is a *stronger* non-convergence signal
than the round ceiling: the same finding survived a fix attempt unchanged, rather
than the reviewer churning out fresh variants. That path continues to hard-park at
`needs-human` and is **not** governed by `ceiling_action`. Only the
`max_adversarial_rounds` round-budget ceiling gains the demote-and-advance option.

### Reuse the audited override-disposition record, not a new bypass

The hard part is making the item actually reach `ready-to-deploy` after the
transition. Pre-merge's review-SHA gate reuses the recorded verdict by reading the
`pipeline-blocking-keys` marker and computing `unresolved = recorded − overrides`;
a non-empty `unresolved` re-parks at `needs-human`. So demote-and-advance records
an **audited override disposition** (`overrideComment` → the
`<!-- pipeline-override: <key> <disposition> -->` sentinel that `extractOverrides`
already reads) for each demoted finding, with a disposition/reason that references
the follow-up issue (e.g. `auto-demoted at review ceiling; deferred to #<n>`).
Pre-merge then computes `unresolved = ∅` and proceeds — no new gate-bypass code,
the same reconciliation a human `--override` would trigger. This is the decision
that makes "advance to ready-to-deploy" true rather than aspirational.

### Single tracked follow-up issue, filed at most once

The demoted findings are captured in **one** GitHub issue created through the
`createIssue(title, body, labels)` dependency seam already used by intake
(`stages/intake.ts`). The body lists every demoted finding (title, severity,
category, `override-key`, `file:line`) and back-links the original issue
(`Deferred review findings from #<original>`). The issue does **not** carry a
`pipeline:` stage label, so it does not auto-enter the pipeline.

Idempotency: a re-entry could hit the ceiling again. The demotion comment carries
a machine marker (e.g. `<!-- pipeline-ceiling-followup: #<n> -->`); before
creating, the stage scans existing comments for that marker and skips creation if
present, re-using the recorded issue number. This prevents duplicate follow-ups
across re-runs.

### Dependency seam

`AdvanceReviewDeps` gains an optional `createIssue?: (title, body, labels) =>
Promise<number>` seam, defaulted to the same `gh issue create` wrapper intake
uses. Unit tests inject a fake that records the call and returns a fixed number —
no real network, consistent with the repo's test conventions (`ShaGateDeps`,
`VerifyDeps`).

## Risks / Trade-offs

- **A genuinely material medium finding gets deferred.** Mitigated by: it is never
  *dropped* (PR comment + tracked follow-up issue), the behavior is opt-in, and
  high/critical always park. A repo whose mediums are frequently material keeps
  the default `park`.
- **Follow-up issue spam.** Mitigated by the once-per-item idempotency marker.
- **Override sentinel collides with a human override.** The auto-disposition uses
  the same `findingKey` a human override would; if a human already overrode the
  key, the disposition is redundant, not conflicting.

## Migration

None — additive config key with a behavior-preserving default. Existing repos see
no change until they set `review_policy.ceiling_action: demote_and_advance`.
