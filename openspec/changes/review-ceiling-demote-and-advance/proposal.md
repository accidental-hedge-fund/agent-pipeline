## Why

When an adversarial review round (`review-2`) hits `max_adversarial_rounds`, the
pipeline hard-parks at `needs-human` with the still-blocking findings recorded as
advisory but the item **stopped** — even when every remaining finding is below
high severity and the change is low-risk. The automated path is therefore a
*park*, not a *converge*: each fix commit triggers a stateless SHA-gate
re-review → fresh medium nits → fix → … and the only brake (the round ceiling)
hands off to a human.

Evidence:

- **3 of 5** recent issues required human nudges to converge; **#214** and
  **#186** each needed **6–8** relabel-`needs-human`→`review-2`-and-resume cycles
  to land changes that were ultimately low-risk.
- At the ceiling today, blocking findings are **not** demoted — they are parked
  as-is, so a human must override or fix each one before the item can advance,
  even when none is high/critical.

The fix: at the ceiling, when no **high/critical** finding remains, auto-demote
the remaining (below-high) findings to advisory, file a **single tracked
follow-up issue** capturing them, and advance through pre-merge to
`ready-to-deploy` without a human. **High/critical** findings continue to
hard-park at `needs-human` — safety is unchanged. No finding is ever silently
dropped: every demoted finding is recorded on the PR and in the follow-up issue.

This is the change that lets the automated flow *terminate at `ready-to-deploy`*
on low/medium-risk changes. It pairs with risk-proportional blocking (#232,
shipped) and the theme-based recurrence guard (tracked separately).

## What Changes

- **New config key `review_policy.ceiling_action`.** An enum `park |
  demote_and_advance`, default **`park`** (current behavior — opt-in, so the
  rigor floor is preserved by default per the never-default-demote rule). It is
  added to the config schema, documented in the `.github/pipeline.yml` reference,
  and registered in `RIGOR_GATING_PATHS` so a rename cannot silently orphan it.
- **Ceiling severity split.** At the `max_adversarial_rounds` ceiling, the
  still-blocking findings are partitioned into **high/critical** vs **below high**
  (`severityRank(f.severity) >= severityRank("high")` is the cut). The split
  reuses the existing `severityRank` helper.
- **Park when any high/critical remains.** If one or more high/critical findings
  are still blocking at the ceiling, the item hard-parks at `needs-human` exactly
  as today — regardless of `ceiling_action`. This is the unchanged safety path.
- **Demote-and-advance when none remain.** When `ceiling_action` is
  `demote_and_advance` **and** no high/critical finding remains, the below-high
  findings are demoted to advisory: the pipeline (a) posts an audited
  demotion comment on the PR, (b) records an audited override disposition per
  demoted finding (keyed by `findingKey`) so the pre-merge review-SHA gate's
  existing override-vs-blocking-keys reconciliation does **not** re-park the item,
  (c) files **one** tracked follow-up GitHub issue capturing every demoted
  finding (title, severity, category, `override-key`, location) and back-linking
  the original, and (d) transitions to the normal next stage (`pre-merge`) instead
  of `needs-human` — so the item advances to `ready-to-deploy` on its own.
- **Idempotent follow-up.** The follow-up issue is filed at most once per item: a
  marker on the demotion comment is checked before creating, so a re-entry that
  hits the ceiling again does not file a duplicate.

The mechanism reuses existing machinery — `severityRank`, the audited
`overrideComment` disposition record that pre-merge already honors, and the
`createIssue` dependency seam used by intake. The `park` path (default) is
byte-for-byte today's behavior.

## Acceptance Criteria

- [ ] At `max_adversarial_rounds`, findings of severity **high or critical**
      continue to park the item at `needs-human` (unchanged safety behavior),
      regardless of `ceiling_action`.
- [ ] At the ceiling with `ceiling_action: demote_and_advance` and no
      high/critical finding remaining, the below-high findings are demoted to
      advisory, recorded on the PR, and captured in a **single** tracked follow-up
      GitHub issue back-linked to the original — listing each finding's title,
      severity, category, and `override-key`.
- [ ] After demotion with no high/critical remaining, the item advances through
      pre-merge to `ready-to-deploy` without human intervention — the demoted
      findings are recorded as audited dispositions so the pre-merge review-SHA
      gate does **not** re-park the item.
- [ ] The behavior is gated by `review_policy.ceiling_action` (default `park`);
      with the default, the ceiling is byte-for-byte the current hard-park (no
      follow-up issue, no demotion, no advance).
- [ ] No finding is lost: every demoted finding appears in the follow-up issue
      body and in the PR demotion comment.
- [ ] The follow-up issue is filed at most once per item (idempotent on a
      re-entry that hits the ceiling again).
- [ ] `review_policy.ceiling_action` is documented in `.github/pipeline.yml` and
      present in `RIGOR_GATING_PATHS`.
- [ ] Regression tests prove: (a) ceiling with only medium findings +
      `demote_and_advance` → advisory + one follow-up issue + transition to
      `pre-merge` (not `needs-human`); (b) ceiling with a high finding present →
      `needs-human` regardless of `ceiling_action`; (c) `ceiling_action: park`
      (default) + only medium findings → hard-park at `needs-human`, no follow-up
      issue (current behavior); (d) the recorded override dispositions cover the
      demoted keys so pre-merge does not re-park.

## Scope

In scope: the `ceiling_action` config key and its documentation/registration; the
high/critical-vs-below-high split at the `max_adversarial_rounds` ceiling; the
demotion comment, the audited override-disposition records, the single tracked
follow-up issue (with idempotency), and the transition to `pre-merge` instead of
`needs-human` when nothing high/critical remains.

## Out of Scope

- Changing the `max_adversarial_rounds` default.
- The recurrence/whack-a-mole early-park (`review-loop-recurrence`): that path is
  a stronger non-convergence signal (a finding survived a fix unchanged) and
  **continues to hard-park** — `ceiling_action` does not relax it. The detection
  that decides when to invoke the ceiling early is tracked separately.
- Auto-merging the follow-up issue or auto-fixing the demoted findings (the
  pipeline never merges).
- Changing the severity rubric, `block_threshold`, or `min_confidence`.

## Capabilities

### New Capabilities

- `review-ceiling-demote-and-advance`: at the `max_adversarial_rounds` ceiling,
  demote remaining below-high findings to advisory, file one tracked follow-up
  issue, and advance to `pre-merge` — gated by `review_policy.ceiling_action`;
  high/critical findings still park.

### Modified Capabilities

- `pipeline-configuration`: a new optional `review_policy.ceiling_action` enum
  (`park | demote_and_advance`, default `park`), registered in
  `RIGOR_GATING_PATHS`.

## Impact

- `core/scripts/types.ts` — `review_policy.ceiling_action: "park" |
  "demote_and_advance"` added to the config type and `DEFAULT_CONFIG` (`"park"`).
- `core/scripts/config.ts` — schema field (enum, default `"park"`), resolution,
  a `RIGOR_GATING_PATHS` entry, and the `.github/pipeline.yml` doc line.
- `core/scripts/stages/review.ts` — at the ceiling, split findings by severity;
  on `demote_and_advance` with no high/critical, post the demotion comment, record
  override dispositions, file the single follow-up issue, and transition to
  `pre-merge`; otherwise hard-park unchanged. A new `createIssue` dep seam on
  `AdvanceReviewDeps`.
- `core/scripts/review-policy.ts` — reuse `severityRank` / `overrideComment`; no
  new partition logic.
- `core/test/` — regression tests for the four cases above plus the
  severity-split helper and follow-up-issue idempotency.
- `.github/pipeline.yml` — documented `ceiling_action` line under `review_policy`.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).
