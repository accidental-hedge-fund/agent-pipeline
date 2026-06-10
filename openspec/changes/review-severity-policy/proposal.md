## Why

The review layer treats **every** `needs-attention` finding as a hard block that routes to a fix
round, regardless of severity or confidence. A medium-severity scope-creep finding — or an outright
reviewer false-positive — blocks ship exactly as hard as a real high-severity bug, with no escape
hatch. When the reviewer is wrong or out of scope and keeps re-emitting the same finding (re-reviewed
on every HEAD move by the SHA gate), the item cannot converge: it grinds to the per-run transition
cap and blocks. This is the failure mode observed on #56, where the adversarial reviewer re-flagged a
regex on the very commit that fixed it and the pipeline had no way to disposition the finding and
advance.

## What Changes

- Add a `review_policy` config section: `block_threshold` (`critical`|`high`|`medium`|`low`) and
  `min_confidence` (0..1). Findings below the threshold severity **or** below the confidence floor are
  recorded as **advisory** — they do not route to a fix round.
- Verdict routing partitions a `needs-attention` verdict's findings into blocking / advisory /
  overridden. Only blocking findings route to a fix round. When none block, the item **advances** as
  if approved, with an audited comment recording the advisory/overridden findings.
- Add **audited operator overrides**: each finding is shown with a stable content-addressed key in the
  review comment. A new `--override "<key>: <reason>"` CLI posts an audited `pipeline-override` comment
  sentinel; the verdict gate reads active overrides and excludes those findings from blocking. GitHub
  comment authorship supplies the "who"; the comment body the "why".
- Default (`block_threshold: "low"`, `min_confidence: 0`) reproduces pre-change behavior exactly: every
  finding blocks.

## Capabilities

### New Capabilities

- `review-severity-policy`: A per-repo policy declaring which finding severities/confidences block
  progression vs. merely advise, plus an audited override mechanism for dispositioning an individual
  blocking finding so the item can advance.

### Modified Capabilities

- `review-layer`: verdict-driven routing now consults the severity policy and active overrides when a
  `needs-attention` verdict carries findings, rather than routing unconditionally to a fix round.

## Impact

- **Files**: `core/scripts/review-policy.ts` (new), `core/scripts/types.ts`, `core/scripts/config.ts`,
  `core/scripts/stages/review.ts`, `core/scripts/pipeline.ts`, tests, and the generated `plugin/` mirror.
- **Backward compatible**: default policy blocks on every finding (today's behavior); a repo opts in via
  `.github/pipeline.yml`.
- **No auto-merge / no autonomy change**: advancing past advisory findings still stops at
  `ready-to-deploy`; the human still owns the merge button. Overrides are recorded, never silent.
