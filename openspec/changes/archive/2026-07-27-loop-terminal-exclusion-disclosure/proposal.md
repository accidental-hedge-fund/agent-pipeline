## Why

Starting the v1.28.1 lane surfaced an operator false-success in the loop's terminal
summary. Every selected item was **precondition-excluded** (#568's gate: neither issue had
been triaged to `pipeline:ready`), so **nothing was dispatched** — yet the run reported
success:

```
$ pipeline loop --milestone v1.28.1
{"schema_version":"1","engine":"claude","run_id":"loop-…","cycles":1,"stop":null,
 "hold_outstanding":false,"held_item_ids":[],"all_done":true,"resumed":false}
$ echo $?   # 0
```

`all_done: true` + exit 0 reads as "the milestone is complete." It was not: the two open
issues simply had not been triaged yet. The supervisor's own internal accounting already
knows the difference — the action-evidence entry for that cycle records
`noop → all_items_done_or_excluded`, and each excluded item records
`exclude_item → precondition:required=pipeline:ready,observed=none`
(`core/scripts/loop/supervisor.ts` lines ~366–409) — but the surfaced summary collapses
**done** and **excluded** into a single `allDone` boolean. The distinction is recoverable
only by separately running `pipeline loop --audit` after the fact, which an operator
reading a green exit code has no reason to do.

This is the same operator-visibility family as #611 (no per-item stage surface) and #581's
held-item enumeration, and the same remedy shape: the terminal report must name what
actually happened, not the coarsest boolean. It is purely an observability change —
the exclusion/precondition semantics themselves (#568, capability
`loop-precondition-stage-gate`) are correct and stay exactly as they are.

## What Changes

- **`all_done` stops meaning "done or excluded."** The terminal summary SHALL report
  `all_done: true` only when every work-list item reached a terminal-*successful* state
  (done/abandoned). A run that resolves with one or more items merely **excluded** SHALL
  NOT report `all_done: true`.
- **The terminal summary carries dispatch/exclusion accounting.** The supervisor's drive
  result and the `pipeline loop` JSON gain machine-readable fields: how many items were
  dispatched, how many were excluded, which item ids were excluded, and the dominant
  exclusion reason. A `completion` classifier names the resolved shape:
  `all_done` (nothing excluded), `partial_excluded` (some dispatched, some excluded), or
  `none_dispatchable` (zero dispatched, ≥1 excluded).
- **Exclusions are visible on the CLI, not only in `--audit`.** When a run resolves with
  ≥1 excluded item, the command SHALL print a human-readable line naming the excluded count,
  the excluded item ids, and the dominant reason (e.g.
  `2 excluded: need pipeline:ready (#607, #608)`).
- **A `none_dispatchable` run no longer exits 0.** It SHALL exit with a distinct code (`2`),
  separate from both success (`0`) and the existing stop/hold failure (`1`), so automation
  reading only the exit status is not misled into treating "nothing ran" as "everything
  shipped."
- **No semantic change to exclusion or scheduling.** The precondition gate keeps excluding
  the same items for the same reasons, non-fatally, re-evaluated each cycle; the run still
  resolves rather than spinning to the watchdog; no recovery budget, stop policy, label
  write, or merge boundary changes.

## Acceptance criteria

- [ ] A run whose items are **all** precondition-excluded (zero dispatched) reports
      `all_done: false` and `completion: "none_dispatchable"` in the `pipeline loop`
      terminal JSON — not `all_done: true`.
- [ ] That same run exits with code `2` (distinct from `0` success and `1` stop/hold), and
      prints a human-readable line on the CLI naming the excluded count, the excluded item
      ids, and the dominant exclusion reason — without the operator running `--audit`.
- [ ] The terminal JSON carries machine-readable `dispatched` (number), `excluded` (number),
      `excluded_item_ids` (string array), `exclusion_reason` (dominant reason string or
      `null`), and `completion` fields alongside the existing keys, with
      `schema_version: "1"` keys otherwise unchanged (additive only).
- [ ] A run in which every item reached a terminal-successful state and **no** item was
      excluded still reports `all_done: true`, `completion: "all_done"`, `excluded: 0`,
      `exclusion_reason: null`, and exits `0` — no regression to the existing success path.
- [ ] A mixed run (≥1 item dispatched to a terminal-successful state, ≥1 item excluded)
      reports `all_done: false`, `completion: "partial_excluded"`, non-zero `dispatched` and
      `excluded` counts, exits `0`, and still prints the excluded-count line.
- [ ] A run that ends in a recorded stop or an outstanding hold keeps its current reporting
      and exit code `1`; `completion` is `null` for a non-resolved run, and the existing
      `stop` / `hold_outstanding` / `held_item_ids` disclosures are unchanged.
- [ ] The dominant exclusion reason is deterministic: the most frequent exclusion reason
      among excluded items, ties broken by a stable ordering, so the same run state always
      renders the same summary.
- [ ] No change to precondition/exclusion semantics: an excluded item is still non-fatally
      excluded, re-evaluated against live truth each cycle, consumes no recovery budget, and
      records no run stop; a mid-run triage to `pipeline:ready` still admits the item.
- [ ] Regression test: a work-list whose items are all precondition-excluded drives to a
      terminal condition and yields `all_done: false` / `completion: "none_dispatchable"` /
      `dispatched: 0` / `excluded: N` with exit code `2`. The test bites — it fails against
      the current `all_done: true` + exit `0` behavior.
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install smoke,
      `openspec validate --all`).

## Capabilities

### New Capabilities

- `loop-terminal-exclusion-disclosure`: the loop's terminal summary distinguishes "every
  item reached a terminal-successful state" from "items were merely excluded (nothing
  dispatchable)" — reporting dispatch/exclusion counts, the excluded item ids, the dominant
  exclusion reason, and a `completion` classifier in both the durable drive result and the
  `pipeline loop` CLI output, with a distinct exit code when zero items were dispatchable.

## Impact

- `core/scripts/loop/supervisor.ts` — `SupervisorCycleResult` / `DriveSupervisorResult` gain
  the dispatch/exclusion accounting the terminal report renders (`allDone` narrowed to
  terminal-successful items only; excluded ids + reasons carried out of the resolving cycle).
- `core/scripts/pipeline.ts` — `runLoopCommand` renders the new fields, prints the
  excluded-count line, and maps `none_dispatchable` to exit code `2`.
- `core/test/loop-command.test.ts`, `core/test/loop-supervisor*.test.ts` — new regression
  coverage; the existing `all_done: true` assertion is retargeted at a genuinely all-done run.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).
- No change to `core/scripts/loop/precondition.ts`, the scheduler, the recovery/stop
  policies, label writes, or the never-merge boundary.
