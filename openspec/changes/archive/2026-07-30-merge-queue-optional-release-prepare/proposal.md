## Why

After a human-gated merge-queue drive empties a milestone’s ready-to-deploy merge
candidates, operators still have to remember to run `pipeline release` by hand.
That toil is pure ceremony once the queue is clean: version bump, ROADMAP, mirror,
and a release PR for human review. An opt-in **release-when-complete** hook removes
that reminder without auto-tagging, auto-publishing, or auto-merging the release.

## What Changes

- Add an **opt-in** merge-queue flag (and optional config default, false) so that
  when a drive finishes and the queue is **complete**, the tool prepares the next
  release PR via the **existing** `pipeline release` prepare path (`runRelease` /
  shared library it already uses).
- Define **queue-complete** deterministically for this purpose: no remaining open
  selector-scoped candidates with `pipeline:ready-to-deploy` PRs, and no held
  merge-queue items from the drive. Open non-R2D milestone issues do **not** block
  release prepare (they are reported as a warning).
- Default merge-queue drive remains merge-only: without the flag/config, **no**
  release is prepared.
- On complete + flag, invoke prepare only — produce a release PR for human review.
  **SHALL NOT** tag, publish to npm, or merge the release PR.
- Release-prepare failure is non-destructive to merges already performed: clear
  error, queue success for merges remains intact.
- Dry-run SHALL report whether release would be prepared (and why not, if not),
  without creating a PR or mutating release-managed paths.
- Unit tests with injected release deps prove opt-in, completeness gating, and
  no-tag / no-merge / merge-success isolation invariants.

## Acceptance Criteria

- [ ] Without `--release-when-complete` (and with config default false), a completed
  merge-queue drive prepares **no** release PR and does not call the release path.
- [ ] With the flag (or config true) and a **complete** queue, the drive invokes the
  existing release prepare path and produces a release PR for human review (live mode).
- [ ] **Complete** means: zero remaining open selector-scoped candidates that have
  `pipeline:ready-to-deploy` PRs **and** zero held merge-queue items; open non-R2D
  issues on the milestone do **not** block prepare (they surface as a warning).
- [ ] When the queue is incomplete (remaining R2D candidates or held items), release
  prepare is **skipped** even if the flag is set, with a clear skip reason.
- [ ] Release prepare **never** tags, publishes to npm, or merges the release PR as
  part of this path.
- [ ] If release prepare fails after successful merges, the command surfaces a clear
  error naming the release failure and does **not** undo or re-attempt merges already
  done; merge outcomes remain successful.
- [ ] Dry-run with the flag reports whether release **would** be prepared (version
  alias/semver, completeness, skip reason) and creates **no** PR and **no** release
  file mutations.
- [ ] Live release-when-complete runs non-interactively (no `$EDITOR` wait) so a
  drive can finish unattended prepare after merges.
- [ ] Unit tests with injected release/merge-queue deps cover: default off; complete +
  flag → prepare called; incomplete → not called; prepare failure leaves merge
  success intact; dry-run does not create a PR; prepare path does not tag/merge/publish.
- [ ] `npm run ci` green; regenerate `plugin/` if `core/` changes.

## Capabilities

### New Capabilities

- `merge-queue-release-when-complete`: Opt-in post-drive release preparation when
  the human-gated merge queue is complete — completeness definition, flag/config
  surface, dry-run disclosure, failure isolation, and no-tag/no-merge invariants.
  Depends on the merge-queue drive surface from the sibling cluster (#673–#675)
  for candidate selection, hold state, and apply/dry-run modes.

### Modified Capabilities

- `release-sub-command`: Clarify that the release prepare path remains the sole
  producer of release PRs and is invocable programmatically (shared `runRelease`
  entry) without adding tag/merge/publish authority; no change to semver policy,
  ROADMAP scaffold sites, or post-merge auto-tag workflow.

## Impact

- Merge-queue drive/orchestration (sibling #674 surface): after successful drive
  completion check, optional call into release prepare.
- `core/scripts/stages/release.ts` (`runRelease` / `ReleaseDeps`): reused as the
  prepare implementation; may need a thin programmatic options path already
  present (`dryRun`, `noEdit`) rather than CLI re-entry.
- Config (if any): opt-in default false only — **no** `auto_merge` key.
- Tests: injected release deps on the merge-queue completion path.
- Human still owns merge of the release PR; post-merge tag/publish remains the
  existing release workflows after human merge — unchanged.
- Out of scope: fully automated GitHub Release / npm publish from this path;
  changing semver policy beyond current `pipeline release`; closing milestones
  via API; inventing a second release implementer.
