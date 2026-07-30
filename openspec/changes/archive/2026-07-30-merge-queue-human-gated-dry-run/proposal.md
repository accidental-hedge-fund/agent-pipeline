## Why

Operators finishing a milestone (or similar selector) often end with a pile of
`pipeline:ready-to-deploy` PRs and must invent order, re-check CI/mergeability,
and run `/pipeline:merge` one by one by hand. The pipeline already has a
human-only per-PR merge primitive (`pipeline merge <pr>`) and a hard rule that
the advance loop never merges — but it has no **queue walker** that selects,
orders, and presents that pile under an explicit operator invocation. Without a
safe dry-run surface first, a later sequential-drive feature cannot be trusted.

## What Changes

- Add a human-invoked **`pipeline merge-queue`** command (name fixed here;
  host packaging may expose `/pipeline:merge-queue`) that selects open PRs
  linked to issues matching a selector (at least **`--milestone <title>`**)
  that carry **`pipeline:ready-to-deploy`**, orders them deterministically, and
  prints the plan.
- **This change implements dry-run only.** Default invocation is dry-run;
  dry-run prints an ordered candidate list (PR, issue, head SHA, check summary,
  mergeability) and each item’s planned next action, with **zero** merges,
  pushes, label changes, or other GitHub mutations.
- Document required gates for a candidate to be planned as mergeable (R2D
  label, linked open PR via authoritative resolution, mergeability CLEAN,
  required checks green, base branch as configured) and how non-candidates are
  reported (missing PR, non-mergeable, failing/pending checks).
- Preserve golden rule #4: **no** `auto_merge` config key; advance loop remains
  merge-free; only explicit operator invocation of `pipeline merge` (today) or
  a future merge-queue drive (#674) may merge.
- Register the command in the CLI command registry / namespaced host surface
  and cover selection filters with unit tests using injected `gh` fakes.

## Acceptance criteria

- [ ] A human can run `pipeline merge-queue --milestone <m>` (or equivalent with
      explicit `--dry-run`) and receive a deterministic ordered listing of
      ready-to-deploy candidates for that milestone without any merge occurring.
- [ ] Dry-run output includes, for each ordered candidate at least: PR number,
      linked issue number, head SHA, mergeability summary, required-check
      summary, and planned next action.
- [ ] Dry-run performs **zero** merges, pushes, branch deletes, or label/issue
      mutations (observable: no mutating `gh` deps invoked).
- [ ] Dry-run is idempotent: re-running with the same selector and unchanged
      GitHub state yields the same ordered plan (same candidate set and order).
- [ ] Selection includes only issues that carry `pipeline:ready-to-deploy` and
      match the selector; non-R2D issues in the milestone are not merge
      candidates.
- [ ] Selection excludes issues with no open linked PR (via authoritative
      `getPrForIssue`-class resolution) from the merge-candidate list.
- [ ] Selection excludes non-mergeable PRs (`mergeable` not `MERGEABLE` or
      `mergeStateStatus` not `CLEAN`) from the merge-candidate list.
- [ ] Spec and packaging state that the pipeline never merges without explicit
      operator invocation of `pipeline merge` or a future merge-queue drive;
      there is no `auto_merge` config key; advance never calls merge-queue or
      merge.
- [ ] Unit tests cover R2D-only, missing-PR exclusion, and non-mergeable
      exclusion with injected deps (no real network/git/subprocess).
- [ ] `npm run ci` is green; `plugin/` regenerated when `core/` changes;
      `openspec validate merge-queue-human-gated-dry-run` passes.

## Capabilities

### New Capabilities

- `merge-queue-command`: human-invoked merge-queue CLI surface — selector-based
  discovery of ready-to-deploy PRs, deterministic ordering, dry-run plan output,
  loop-isolation and no-`auto_merge` guarantees for this stage of the cluster.

### Modified Capabilities

- `command-registry`: register `merge-queue` as a recognized keyword with an
  allowlist of flags (`milestone`, dry-run, repo/base/profile as needed) and
  non-mutating metadata for the dry-run-only implementation.
- `namespaced-command-surface`: expose `/pipeline:merge-queue` (or equivalent
  host packaging) as a first-class operator command alongside `pipeline:merge`.
- `merge-sub-command`: clarify that per-PR `pipeline merge` remains the sole
  merge primitive in this change; merge-queue dry-run does not call it, and a
  future drive issue may invoke it sequentially without changing merge’s
  gates.

## Impact

- **CLI / engine:** new handler (e.g. `core/scripts/stages/merge_queue.ts` or
  sibling module), dispatch from `pipeline.ts`, registry entry in
  `command-registry.ts`, optional thin packaging command under `hosts/`.
- **GitHub reads only (this issue):** list issues by milestone + label, resolve
  PR, `gh pr view` mergeability/head, `gh pr checks --required` — all behind a
  `MergeQueueDeps` (or similar) injection seam.
- **Tests:** `core/test/merge-queue*.test.ts` — selection filters and dry-run
  non-mutation with fakes.
- **Docs / hosts:** skill one-liners, command table, README if present for
  operator commands.
- **Out of scope (follow-ups):** sequential drive/apply that calls
  `pipeline merge` (#674); conflict/CI repair loops (#675); release-when-
  complete (#676); changing review/CI thresholds; any `auto_merge` config or
  background daemon merge.
