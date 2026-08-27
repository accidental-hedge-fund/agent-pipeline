## Why

An operator can advance and merge every milestone issue one at a time
(`/pipeline N` → `pipeline:ready-to-deploy` → operator `merge`) and still
cannot ship. `pipeline ship --milestone <m>` stops at train freeze with
`no open issues to freeze` when every item is already closed, merged, and
contained in base. `pipeline release` then fails on a missing Factory
Reliability Gate (FRG) pass and names only `pipeline factory-gate --for
<v>`, which is not runnable without a `factory-gate` pack loop on a
native-`/goal` engine. Observed 2026-08-27 on milestone `v1.39.13` (8
CLOSED ready-to-deploy issues, 8 MERGED PRs contained in `main`).

## What Changes

- **Ship / train freeze includes already-integrated items.** Freeze SHALL
  discover closed ready-to-deploy issues whose linked PRs are merged and
  contained in the fetched base, record each as `already-integrated`, and
  proceed to the FRG / release phase. Freeze SHALL NOT stop solely because
  the open-issue set is empty.
- **Mixed milestones stay one run.** Open ready-to-deploy items SHALL
  merge. Already-integrated items SHALL skip merge. Both classes SHALL
  appear in the same freeze plan.
- **FRG-missing diagnostics name the runnable pack path.** `release` /
  `ship` / `factory-gate` failure text SHALL name the pack-loop command
  **and** the native-`/goal` profile, then `factory-gate --for <v>
  --from-run <run-id>`. `Run: pipeline factory-gate --for X` alone SHALL
  NOT remain the only next command.
- **`--skip-frg` stays an escape.** Default release / ship SHALL NOT
  present skip as the only option, and SHALL NOT imply skip as the
  recovery for a non-claude profile. A `no-frg-*` pin stays
  non-production.
- **Docs.** Factory Reliability Gate runbook and supervisor ship text
  SHALL document the already-integrated ship path and the pack-loop
  profile requirement.

This is a **class** fix, not a ship-adapter mole. The class is: a
work-list freeze or milestone selector that enumerates only **open**
issues never reaches merge-mode already-integrated reconciliation. The
same class applies to `pipeline train --milestone`. The FRG class is: a
fail-closed missing-evidence diagnostic that names only the scorer hides
the pack-loop + native-`/goal` profile prerequisite. After this change,
the next all-integrated milestone and the next missing-FRG operator
failure do not need a new mole issue.

**Not in this change:** auto-running FRG packs inside ship; removing or
weakening the production FRG gate; changing native-`/goal` attestation
defaults.

## Acceptance Criteria

- [ ] `pipeline ship --milestone <m>` on a milestone whose every issue is
      closed at `pipeline:ready-to-deploy`, with its PR merged and
      contained in the fetched base, does **not** stop with `no open
      issues to freeze`. Each item is recorded `already-integrated`. The
      run proceeds to the FRG / release phase.
- [ ] A mixed milestone (some open ready-to-deploy with mergeable PRs,
      some already integrated) merges the open items and records the
      merged items as integrated in the **same** run.
- [ ] When FRG evidence is missing, `pipeline release` / `pipeline ship`
      failure text names `pipeline loop --label factory-gate --profile
      claude` (or an equivalent native-`/goal` engine profile) **and**
      `pipeline factory-gate --for <v> --from-run <run-id>`. The text does
      not present `--skip-frg` as the only or implied recovery.
- [ ] `pipeline factory-gate` usage / missing-`--from-run` text also names
      that pack-loop command and profile. It is not scorer-only.
- [ ] `--skip-frg` remains a documented escape. A skip pin remains
      `no-frg-*` / non-production.
- [ ] Unit tests fail if: (a) freeze rejects an all-closed+merged
      milestone instead of classifying items integrated; (b) the
      FRG-missing diagnostic omits the pack-loop command and profile.
- [ ] `docs/factory-reliability-gate-runbook.md` and supervisor ship
      text document the already-integrated ship path and the pack-loop
      profile requirement. OpenSpec deltas exist for both capabilities.
- [ ] After any `core/` edit, `node scripts/build.mjs` regenerates
      `plugin/` in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends living train freeze and FRG diagnostic law. -->

### Modified Capabilities

- `integrated-train-mode`: Milestone freeze / ship train plan SHALL
  include already-integrated closed ready-to-deploy items. An empty
  **open** set SHALL NOT, by itself, stop an all-integrated milestone.
  Mixed open + already-integrated work lists SHALL complete in one run.
- `factory-reliability-gate`: Missing / incomplete FRG evidence on
  `release`, `ship`, and `factory-gate` SHALL name the runnable pack-loop
  command including the native-`/goal` profile, then `--from-run`. Skip
  SHALL NOT be the implied recovery. Runbook and supervisor text SHALL
  match.

## Impact

- **Specs:** deltas on living `integrated-train-mode` and
  `factory-reliability-gate`.
- **Code (implementation, not this proposal step):**
  `core/scripts/stages/ship-adapter.ts` (`planTrain` open-only freeze),
  `core/scripts/stages/train.ts` (milestone `--state open` listing and
  empty-open throw), `core/scripts/factory-reliability-gate.ts`
  (`requireFrgPassForRelease` and missing-`--from-run` usage), ship FRG
  converge diagnostics, tests in `core/test/ship-adapter.test.ts` /
  `core/test/train.test.ts` / `core/test/factory-reliability-gate.test.ts`
  / `core/test/release.test.ts`. Regenerate `plugin/` after core edits.
- **Docs:** `docs/factory-reliability-gate-runbook.md`,
  `docs/supervisor.md` and/or `docs/runbooks/ship-milestone.md`.
- **Conflict (do not average):** living `integrated-train-mode` currently
  says a milestone selector "resolves to **open** pipeline issues." Living
  merge-mode already-integrated law already covers closed ready-to-deploy
  items once they are on the work list. This change updates freeze /
  listing so those items reach that law. `docs/factory-simplification-plan.md`
  still describes `release --skip-frg` as the thin-ship default. Living FRG
  specs and this issue keep FRG required; skip stays an escape only.
- **Does not:** auto-run FRG packs inside ship; weaken production FRG;
  change native-`/goal` attestation defaults; grant merge from advance /
  loop.
