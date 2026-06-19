## 1. Config: `review_policy.ceiling_action`

- [ ] 1.1 Add `ceiling_action: "park" | "demote_and_advance"` to the `review_policy` type in `core/scripts/types.ts` and set it to `"park"` in `DEFAULT_CONFIG.review_policy`.
- [ ] 1.2 Add the schema field in `core/scripts/config.ts` (`z.enum(["park", "demote_and_advance"]).optional()` with a description), default `"park"`, and wire it through config resolution next to `block_threshold` / `min_confidence` / `max_adversarial_rounds`.
- [ ] 1.3 Add `"review_policy.ceiling_action"` to `RIGOR_GATING_PATHS` in `config.ts`.
- [ ] 1.4 Document `ceiling_action` under `review_policy` in `.github/pipeline.yml` generation (commented default `park`, one-line explanation of demote-and-advance at the round ceiling).

## 2. Ceiling severity split

- [ ] 2.1 At the `priorRoundComments.length + 1 >= roundCap` ceiling branch in `stages/review.ts`, partition `partition.blocking` into `highOrCritical` (`severityRank(f.severity) >= severityRank("high")`) and `belowHigh` (the rest), reusing `severityRank` from `review-policy.ts`.
- [ ] 2.2 If `highOrCritical.length > 0` **or** `cfg.review_policy.ceiling_action !== "demote_and_advance"`, keep the existing hard-park: post `reviewCeilingComment`, transition to `needs-human`, return — byte-for-byte today's behavior.

## 3. Demote-and-advance path

- [ ] 3.1 When `ceiling_action === "demote_and_advance"` and `highOrCritical.length === 0` and `belowHigh.length > 0`, build and post an audited demotion comment on the PR/issue listing each demoted finding (title, severity, category, `override-key`, location).
- [ ] 3.2 For each demoted finding, record an audited override disposition via `overrideComment(...)` keyed by `findingKey(f)`, disposition/reason referencing the follow-up issue (e.g. `auto-demoted at review ceiling; deferred to #<n>`), so `extractOverrides` covers the key at pre-merge.
- [ ] 3.3 Add an optional `createIssue?: (title, body, labels) => Promise<number>` seam to `AdvanceReviewDeps`, defaulted to the `gh issue create` wrapper intake uses; do **not** apply a `pipeline:` stage label to the follow-up.
- [ ] 3.4 File **one** follow-up issue capturing all demoted findings (titles, severities, categories, override-keys, locations) and back-linking the original (`Deferred review findings from #<original>`).
- [ ] 3.5 Idempotency: emit a `<!-- pipeline-ceiling-followup: #<n> -->` marker on the demotion comment; before creating, scan existing comments for the marker and skip creation (re-use the recorded number) if present.
- [ ] 3.6 Transition to the normal next stage (`pre-merge`) — not `needs-human` — with a summary noting N findings demoted to advisory and deferred to the follow-up issue.

## 4. Tests

- [ ] 4.1 Severity-split helper: high/critical findings classify as parking; medium/low classify as demotable; unknown/garbled severity classifies as medium (demotable) per `severityRank`.
- [ ] 4.2 Regression (a): ceiling with only medium findings + `demote_and_advance` → demotion comment posted, exactly one `createIssue` call, override dispositions recorded for each demoted key, transition to `pre-merge` (not `needs-human`).
- [ ] 4.3 Regression (b): ceiling with a high finding present + `demote_and_advance` → hard-park at `needs-human`, no `createIssue` call, no demotion.
- [ ] 4.4 Regression (c): ceiling with only medium findings + default `ceiling_action: park` → hard-park at `needs-human`, no `createIssue` call (current behavior).
- [ ] 4.5 Pre-merge integration: the override dispositions recorded by the demote path cover the demoted keys so the pre-merge review-SHA gate computes `unresolved = ∅` and does not re-park.
- [ ] 4.6 Idempotency: a second ceiling entry with the follow-up marker already present files no second issue and re-uses the recorded number.
- [ ] 4.7 Prove each regression bites: it fails against the pre-change behavior.

## 5. Mirror + CI

- [ ] 5.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 5.2 Run `npm run ci` from the repo root; all checks green.
