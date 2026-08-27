## Context

See `proposal.md` for why. Current law and code:

- Living `integrated-train-mode` already treats a finished ready-to-deploy
  item with a merged, contained PR as `already-integrated`. That path lives
  in train merge-mode (`mergeReadyToDeployItem` /
  `reconcileMergedPrIntegration`).
- Living `integrated-train-mode` also says a milestone selector "resolves
  to **open** pipeline issues." `pipeline train --milestone` lists
  `--state open` and throws `has no open issues` on an empty list.
  In-engine `pipeline ship` freeze (`planTrain`) lists `--state open` and
  throws `no open issues to freeze` before train merge-mode runs.
- Ship `runTrain` already injects `listMilestoneIssues(..., "all")` and
  `getPrForIssue` any-state, so already-integrated reconciliation is
  reachable **only after** freeze hands it a work list. Freeze is the
  gate that drops the closed set.
- `requireFrgPassForRelease` and `factory-gate` missing-`--from-run` usage
  name `pipeline factory-gate --for <v>` (scorer only). Native-`/goal`
  preflight on `pipeline loop` refuses the default codex profile
  (`codex 0.150.0` has no `/goal`). `factory-release prepare` already
  spawns the bound pack loop with `--profile claude`. `--skip-frg`
  remains a documented escape that writes a non-production `no-frg-*`
  pin.

**Conflict (do not average):** freeze enumerates only open issues; merge
mode already knows how to skip closed+merged ready-to-deploy items.
`docs/factory-simplification-plan.md` still describes `release
--skip-frg` as the thin-ship default. Living FRG specs and this issue
keep FRG required; skip stays an escape.

**Class vs site (engine-dogfood bar):** this is a **class** fix.

1. **Freeze / milestone selector class.** Site symptom: `pipeline ship
   --milestone v1.39.13` stops at freeze. The class is: a work-list
   freeze or milestone selector that enumerates only **open** issues
   never reaches already-integrated reconciliation. Shared surfaces:
   ship `planTrain` freeze **and** `pipeline train --milestone` listing.
   A ship-adapter-only mole leaves `train --milestone` with the same
   fault.
2. **FRG-missing diagnostic class.** Site symptom: `Run: pipeline
   factory-gate --for 1.39.13`. The class is: fail-closed missing-FRG
   text that names only the scorer hides the pack-loop + native-`/goal`
   profile. Shared surfaces: `requireFrgPassForRelease`, `factory-gate`
   usage / missing-`--from-run`, ship FRG converge diagnostics, runbook
   and supervisor ship text.

After this lands, the next all-integrated milestone and the next
missing-FRG operator failure do **not** need a new mole issue.

## Goals / Non-Goals

**Goals:**

- One shared freeze / listing rule: include open pipeline-eligible
  issues **and** closed issues labeled `pipeline:ready-to-deploy`.
- Reuse existing merge-mode already-integrated reconciliation. Do not
  invent a second integrated classifier at freeze time.
- Fail freeze only when there are **zero freeze-eligible** issues, not
  when the open subset is empty.
- One shared missing-FRG diagnostic that names the pack-loop command
  with `--profile claude` (the documented native-`/goal` engine) and
  `factory-gate --for <v> --from-run <run-id>`.
- Keep `--skip-frg` documented as an escape. Do not lead with it. Do
  not imply it as the recovery for a non-claude profile.

**Non-Goals:**

- Auto-running FRG packs inside `pipeline ship`.
- Removing or weakening the production FRG gate.
- Changing native-`/goal` attestation defaults (`loop.native_goal`).
- Treating closed issues **without** `pipeline:ready-to-deploy` as
  integrated (label-stripped / cancelled items are a different class).
- Granting merge from advance / loop.
- Restoring skip-frg as a Tugboat or ship default.

## Decisions

### 1. Shared freeze listing, not a ship-only mole

**Choice:** Both `pipeline ship` freeze and `pipeline train --milestone`
SHALL list milestone issues with state `all` (or equivalent) and keep
freeze-eligible items: open non-backlog pipeline issues, plus closed
issues labeled `pipeline:ready-to-deploy`. An empty **open** subset
SHALL NOT throw `no open issues to freeze` / `has no open issues` when
at least one freeze-eligible closed ready-to-deploy item exists.

**Why:** Already-integrated reconciliation is already the class law in
train merge-mode. Freeze is what prevents it from running. Train
`--milestone` uses the same open-only listing class.

**Alternatives considered:**

- Ship-adapter-only: list `all` in `planTrain`, leave train
  `--milestone` open-only → rejected; class-over-site forbids a
  path-local mole.
- Freeze-time containment proof in `planTrain` before train runs →
  rejected; duplicates `reconcileMergedPrIntegration` and its
  containment / observe blockers.
- Treat every closed milestone issue as integrated → rejected; cancelled
  or never-R2D closed issues are not a ship plan.

### 2. Train classifies; freeze only admits

**Choice:** Freeze / listing admits candidates. Train merge-mode records
`already-integrated` when the linked PR is merged and the merge-result
is contained in the fetched base. A closed ready-to-deploy item with no
merged contained PR SHALL still fail closed on the existing
no-open-PR / containment class, not be skipped as integrated.

**Why:** The living already-integrated requirement already states this.
Freeze should not invent a weaker skip.

**Alternatives considered:**

- Freeze skips closed R2D without calling train → rejected; then mixed
  milestones would drop the integrated set from the ship plan, and
  containment failure would be silent.

### 3. Shared missing-FRG diagnostic, skip is not the implied path

**Choice:** A single diagnostic string (or helper) used by
`requireFrgPassForRelease`, `factory-gate` missing-`--from-run` usage,
and ship FRG converge SHALL include, in this order:

1. The missing evidence path / version (existing).
2. The pack-loop command with native-`/goal` profile:
   `pipeline loop --label factory-gate --profile claude`.
3. The scorer: `pipeline factory-gate --for <v> --from-run <run-id>`.

Durable `factory-release prepare` MAY appear as an additional line
(ship already names it for post-pilot). `--skip-frg` MAY appear as a
last-line documented escape. It SHALL NOT be the first, only, or
implied next command. A non-claude active profile SHALL NOT be told
that skip is how that profile ships.

**Why:** `factory-release prepare` already spawns `--profile claude`.
Direct `pipeline loop --label factory-gate` on the default codex
profile is the dead end operators hit. The issue's runnable path is
loop + profile, then `--from-run`. Out of scope: auto-running that
loop inside ship.

**Alternatives considered:**

- Auto-dispatch the pack loop from ship / release → rejected; issue out
  of scope ("Auto-running FRG packs inside ship").
- Point only at `factory-release prepare` → rejected; issue AC names
  the loop + profile + `--from-run` sequence, and `release` does not
  go through prepare.
- Default `--skip-frg` on non-claude profiles → rejected; a `no-frg-*`
  pin is non-production and is not an acceptable quality outcome.

### 4. Documented native-`/goal` profile is `claude`

**Choice:** Diagnostics and docs SHALL name `--profile claude` as the
runnable native-`/goal` engine for the pack loop. They SHALL NOT change
`loop.native_goal` attestation defaults. They SHALL NOT claim every
engine has `/goal`.

**Why:** Claude is the only `LoopEngine` with a documented native-`/goal`
floor. Codex 0.150.0 fails the probe. Prepare already hard-wires
`--profile claude` for the same reason. Changing attestation is out of
scope.

## Risks / Trade-offs

- **[Risk]** Closed ready-to-deploy issues that are **not** merged /
  contained enter the work list and fail later in train, not at freeze.
  → **Mitigation:** that is existing merge-mode fail-closed law. Freeze
  must not hide those as integrated. Tests cover mixed success and
  closed-R2D-without-merged-PR failure.

- **[Risk]** `gh issue list --state all --limit 200` on a large
  historical milestone includes old closed items and hits the 200-issue
  cap. → **Mitigation:** keep the existing 200-issue discovery limit
  throw. Filter to open non-backlog plus closed `pipeline:ready-to-deploy`
  so cancelled noise does not become the work list. If a milestone is
  genuinely >200, today's split-or-paginate error still applies.

- **[Risk]** Naming `--profile claude` in diagnostics will drift if
  another engine later gains `/goal`. → **Mitigation:** this change does
  not alter attestation. A later engine-floor change updates the
  documented profile in the same helper. Do not auto-detect inside the
  diagnostic string.

- **[Risk]** Operators still treat `--skip-frg` as the easy path.
  → **Mitigation:** skip is last-line only, labeled escape, and still
  writes `no-frg-*`. Tests fail if skip is the only named recovery.

## Migration Plan

No data migration. Behavior changes on the next `pipeline ship` /
`pipeline train --milestone` / `pipeline release` invoke. Existing FRG
artifacts and skip-escape semantics stay. Rollback is revert of the
change; the previous open-only freeze and scorer-only diagnostic
return.

## Open Questions

None. The native-`/goal` profile in diagnostics is `claude` until a
later change documents another engine floor.
