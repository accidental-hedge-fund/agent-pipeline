## Why

`pipeline train --merge` (and the ship path that invokes it) **STOPs the entire
milestone** when GitHub returns `mergeable: UNKNOWN` on a ready-to-deploy PR.
That state is a short-lived GitHub compute gap, not a product or authority block.
Live ships failed this way for #693 PR #1057 and #1059 PR #1070; minutes later
the same PRs were `MERGEABLE`/`CLEAN` and merged under operator retry. The
merge surface already tells the operator to “wait a few seconds and retry,” but
the engine never retries — train exits 1 and kills the ship.

## What Changes

- **BREAKING (product behavior for UNKNOWN only):** The issue-PR merge surface
  (`mergePr` / `pipeline merge` gates) SHALL **not** treat a first-read
  `mergeable: UNKNOWN` as a terminal refusal. It SHALL wait and re-read
  mergeability under a **bounded** retry budget (small fixed attempt count and
  short sleep between attempts; on the order of several attempts over tens of
  seconds).
- After the budget is exhausted and mergeability is still `UNKNOWN`, the surface
  SHALL fail closed with an actionable message (same class as today: wait and
  retry later / inspect GitHub).
- `CONFLICTING`, `DIRTY`, `BEHIND`, `BLOCKED`, and other non-`MERGEABLE`/`CLEAN`
  states SHALL remain immediate hard refusals (no optimistic merge).
- The surface SHALL **never** treat `UNKNOWN` as `MERGEABLE` (no speculative
  squash merge while GitHub has not computed mergeability).
- `pipeline train --merge` (serial merge wave / `mergeIssuePr`) inherits this
  behavior through the existing merge surface. A transient UNKNOWN that resolves
  to MERGEABLE+CLEAN within budget SHALL merge and continue the train; it SHALL
  **not** produce a first-attempt ship STOP whose error text is only the
  “PR mergeability is not yet computed (UNKNOWN)…” refusal.
- Regression coverage: the #1059 20:04Z-class STOP text is not a legal
  first-attempt terminal when a later in-budget re-read would succeed.
- Class-over-site: the retry lives in the shared merge gate (or a shared helper
  used by that gate), not a train-only mole that leaves `pipeline merge` and
  other authorized callers broken the same way.

## Acceptance Criteria

- [ ] When the first mergeability read for a PR is `mergeable: UNKNOWN` and a
      later in-budget re-read is `MERGEABLE` with `mergeStateStatus: CLEAN` (and
      other existing merge gates pass), `mergePr` completes the squash merge
      successfully.
- [ ] A hermetic fixture (injected deps / fake sleep) models first
      `getPrDetail`/`ghPrView` UNKNOWN then MERGEABLE+CLEAN; under
      `pipeline train --merge` the item merges, base containment proceeds as
      today, and the train continues (does not exit 1 solely for that first
      UNKNOWN).
- [ ] On first-attempt UNKNOWN that would succeed on re-read within budget, the
      train SHALL NOT emit a terminal ship STOP whose error is only
      `merge failed for #<issue> PR #<pr>: PR mergeability is not yet computed
      (UNKNOWN)...` (the #1059 20:04Z class).
- [ ] After the retry budget is exhausted with mergeability still UNKNOWN, merge
      refuses non-zero / throws with an actionable UNKNOWN message and does
      **not** call `gh pr merge`.
- [ ] `mergeable: CONFLICTING` (and DIRTY / other hard unclean states per
      existing gates) still refuse without merge and without being delayed as if
      they were UNKNOWN retries for a successful path.
- [ ] UNKNOWN is never treated as MERGEABLE: no squash merge runs while the
      latest successful mergeability read in the attempt loop is still UNKNOWN.
- [ ] Retry uses injectable sleep (or equivalent) so unit tests do not real-wait;
      no real network/git/subprocess in unit tests.
- [ ] Unit/regression tests fail if first-attempt UNKNOWN terminal ship-STOP is
      reintroduced for an in-budget success path; `npm run ci` green; regenerate
      `plugin/` if `core/` changes.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `merge-sub-command`: Replace “UNKNOWN mergeability → immediate non-zero
  refuse + wait-and-retry advice” with “bounded wait/re-read of mergeability;
  succeed if MERGEABLE+CLEAN appears within budget; fail closed only after
  budget exhaustion or on real unclean states.” Do not treat UNKNOWN as
  MERGEABLE.
- `integrated-train-mode`: Clarify that train merge waves invoking the shared
  merge surface MUST NOT STOP the milestone on a first-attempt UNKNOWN that the
  merge surface resolves within its retry budget; only post-budget UNKNOWN or
  true gate failures remain train STOP conditions for that merge step.

## Impact

- **Code (intent for later implement):**
  `core/scripts/stages/merge.ts` (`checkMergeability` / `mergePr` gate loop,
  optional `sleep` on `MergeDeps`), callers that already use `mergePr`
  (`train.ts` `mergeIssuePr`, CLI `pipeline merge`, any other authorized merge
  path sharing this surface). Tests in `core/test/merge.test.ts` and train
  merge-wave fixtures.
- **Out of scope:** changing CONFLICTING recovery (#1065 / pre-merge never-park),
  serial merge wave ordering (#1063), merge-queue dry-run skip semantics for
  non-mergeable candidates (unless they share the exact `mergePr` gate and
  inherit automatically), authority/merge-inside-advance rules (unchanged:
  advance/loop never merge).
- **Milestone:** target **v1.39.1** — do not attach to the dead v1.39.0 ship.
- **Related:** #1063 serial merge waves; #1065 never park merge-conflict
  (merged via #1069).
