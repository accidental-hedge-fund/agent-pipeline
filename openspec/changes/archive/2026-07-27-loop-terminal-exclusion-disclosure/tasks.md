# Tasks

## Acceptance criteria

- [x] A run whose items are all precondition-excluded (zero dispatched) reports
      `all_done: false` and `completion: "none_dispatchable"` in the `pipeline loop` terminal
      JSON — not `all_done: true`.
- [x] That run exits with code `2` (distinct from `0` success and `1` stop/hold) and prints a
      CLI line naming the excluded count, the excluded item ids, and the dominant exclusion
      reason — with no `--audit` invocation required.
- [x] The terminal JSON carries additive `dispatched`, `excluded`, `excluded_item_ids`,
      `exclusion_reason`, and `completion` keys; `schema_version` and every pre-existing key's
      name and type are unchanged.
- [x] A fully-completed run with no exclusions still reports `all_done: true`,
      `completion: "all_done"`, `excluded: 0`, `exclusion_reason: null`, and exits `0`.
- [x] A mixed run reports `all_done: false`, `completion: "partial_excluded"`, non-zero
      `dispatched` and `excluded`, exits `0`, and still prints the excluded-count line.
- [x] A stop or outstanding hold keeps its current reporting and exit code `1`, with
      `completion: null` and unchanged `stop` / `hold_outstanding` / `held_item_ids`.
- [x] The dominant exclusion reason is deterministic (most frequent reason; ties broken by a
      stable ordering).
- [x] Held items are not counted as excluded and keep their own disclosure.
- [x] No change to precondition/exclusion semantics: still non-fatal, re-evaluated each cycle,
      no recovery budget consumed, no run stop, mid-run triage still admits the item.
- [x] Regression test that bites: an all-excluded work list yields `all_done: false` /
      `completion: "none_dispatchable"` / `dispatched: 0` / `excluded: N` and exit `2`; it fails
      against the current `all_done: true` + exit `0` behavior.
- [x] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install smoke,
      `openspec validate --all`).

## Implementation

1. [x] In `core/scripts/loop/supervisor.ts`, narrow the resolving-cycle report: keep the
       existing `allDone` **resolution** condition (done/abandoned **or** precondition-excluded)
       as the loop-termination rule, but carry out of the cycle (a) the resolving cycle's
       excluded item ids with their exclusion reason strings and (b) the ledger-derived count of
       items at a terminal-successful state. Do not change which items are excluded or when the
       run resolves.
2. [x] Extend `SupervisorCycleResult` and `DriveSupervisorResult` with the accounting fields
       (dispatched count, excluded ids + reasons) and set `allDone` true only when no item was
       excluded. Derive the dispatched count from the ledger so a resumed run reports the whole
       run's accounting.
3. [x] Add the deterministic dominant-reason helper (most frequent exclusion reason; ties broken
       lexicographically by reason string) next to the exclusion classification, kept pure — no
       gh, git, fs, clock, or store access — so it is unit-testable directly.
4. [x] Derive the `completion` classifier (`all_done` | `partial_excluded` | `none_dispatchable`,
       null for a stop/hold terminal condition) from the drive result; `none_dispatchable`
       requires zero dispatched **and** at least one excluded item, so an empty work list stays
       `all_done`.
5. [x] In `core/scripts/pipeline.ts` `runLoopCommand`, emit the additive JSON keys
       (`dispatched`, `excluded`, `excluded_item_ids`, `exclusion_reason`, `completion`), print
       the excluded-count line (matching the existing #570/#581 disclosure style) whenever
       `excluded > 0`, and set `process.exitCode` to `2` for `none_dispatchable`, keeping `1`
       for stop/hold and `0` otherwise.
6. [x] Tests (co-located `*.test.ts`, dependency-seam fakes, no real network/git/subprocess):
       - [x] Regression: all-excluded work list → `all_done: false`,
             `completion: "none_dispatchable"`, `dispatched: 0`, `excluded: N`, exit `2`, CLI
             line printed. Verify it fails without the fix.
       - [x] Fully-completed run → `all_done: true`, `completion: "all_done"`, `excluded: 0`,
             `exclusion_reason: null`, exit `0`, no excluded line.
       - [x] Mixed run → `partial_excluded`, non-zero counts, exit `0`, excluded line printed.
       - [x] Stop and outstanding-hold runs → `completion: null`, exit `1`, existing
             disclosures unchanged.
       - [x] Dominant-reason helper: most frequent reason wins; a tie resolves deterministically.
       - [x] Held item alongside excluded items is not counted in `excluded` /
             `excluded_item_ids` and is still named by the held-item disclosure.
       - [x] Resumed run counts pre-resume terminal-successful items in `dispatched`.
       - [x] Semantics preserved: an excluded item triaged to the required stage mid-run is
             admitted on a later cycle; an all-excluded run resolves without a watchdog stop.
7. [x] Update the existing `core/test/loop-command.test.ts` `all_done: true` assertion so it
       covers a genuinely all-done run (no excluded items) rather than the conflated case.
8. [x] Document the terminal-summary fields and the `2` exit code wherever the loop command's
       output contract is described (host `SKILL.md` loop section / README loop docs) if such a
       description exists; keep the freeform (non-OpenSpec) path unchanged.
9. [x] Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same
       change.
10. [x] Run `npm run ci` from the repo root; treat red as not-done.
