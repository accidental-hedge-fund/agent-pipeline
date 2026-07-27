# Design

## Context

The supervisor resolves a run when every contract item is done/abandoned **or**
precondition-excluded (`core/scripts/loop/supervisor.ts`, the `allDone` computation):

```ts
const allDone = contract.items.every((i) => {
  const state = ledger.items[i.id]?.state ?? "";
  return DONE_OR_ABANDONED.has(state) || preconditionExcludedIds.has(i.id);
});
```

That disjunction is deliberate and correct as a *scheduling* decision — #568's design
decision 1 chose "an all-backlog work list resolves" over "spin until the no-progress
watchdog." The defect is that the same boolean is then used as the *report*: `allDone`
flows unchanged through `SupervisorCycleResult` → `DriveSupervisorResult` → the
`pipeline loop` JSON's `all_done`, where an operator reads it as "the work is complete."

The information needed to tell the two apart already exists at the resolving cycle:
`preconditionExcludedIds` (the classified exclusions) and the ledger item states. The
action-evidence trail even records the correct distinction (`all_items_done_or_excluded`
vs `all_items_done`) — it is simply not carried out to the surface.

## Decision 1 — Keep the resolution rule; split the report

We do **not** change when a run resolves. An all-excluded work list still terminates on the
resolving cycle rather than spinning to the watchdog. What changes is that the terminal
report distinguishes three resolved shapes:

| `completion`        | meaning                                             |
|---------------------|-----------------------------------------------------|
| `all_done`          | every item terminal-successful, zero excluded        |
| `partial_excluded`  | ≥1 item dispatched to terminal-successful, ≥1 excluded |
| `none_dispatchable` | zero items dispatched, ≥1 excluded                   |

`completion` is `null` for a non-resolved terminal condition (a recorded stop or an
outstanding hold) — those already have their own disclosures (`stop`, `hold_outstanding`,
`held_item_ids`) and are out of scope here.

Alternative considered: leave `all_done` as-is and add fields alongside it. Rejected —
`all_done: true` is precisely the misleading token the issue reports; an operator (or a
script) that reads it and stops reading is the failure mode. `all_done` is therefore
narrowed to "every item reached a terminal-successful state," which is what every reader
already assumes it means. The key stays in the payload with the same type, and the
additional keys are purely additive, so `schema_version` stays `"1"`.

## Decision 2 — Derive the accounting from the resolving cycle's own state

`dispatched` / `excluded` are computed at the resolving cycle from state the supervisor
already holds:

- **excluded** — the item ids in `preconditionExcludedIds` on the cycle that resolves the
  run, with each id's exclusion reason (the same
  `precondition:required=<stage>,observed=<stage>` string the action-evidence entry
  records). Deriving it from the resolving cycle, not from an accumulator across cycles,
  keeps the report a function of live truth: an item excluded in cycle 1 and triaged to
  `pipeline:ready` in cycle 3 is dispatched, not reported excluded.
- **dispatched** — the count of items that reached a terminal-successful (done/abandoned)
  state in the ledger at resolution. Derived from the ledger rather than from an in-process
  counter so a **resumed** run reports the whole run's accounting, not just the cycles this
  process drove.

The two sets are disjoint by construction: `classifyPreconditionExclusions` only classifies
items in the `pending` state, and a done/abandoned item is never `pending`.

Held items (`heldItemIds`, #581) are a separate disposition with its own disclosure and are
**not** folded into `excluded` — a hold is a needs-human pause, not an undispatchable
precondition miss, and an outstanding hold is a distinct terminal condition anyway.

## Decision 3 — Dominant reason, deterministically

The CLI line names one reason rather than N. The dominant reason is the exclusion reason
string with the highest count among excluded items; ties are broken by lexicographic order
of the reason string, so the same run state always renders the same line (a report that
flips between runs is its own operator hazard). The full per-item detail stays available in
`excluded_item_ids` plus the durable action-evidence trail, which is unchanged.

The rendered line reads like the existing #570/#581 disclosures:

```
pipeline loop: 0 of 2 item(s) dispatchable — 2 excluded: need pipeline:ready (#607, #608)
```

`need pipeline:ready` is the human rendering of
`precondition:required=pipeline:ready,observed=none`; the machine-readable
`exclusion_reason` field carries the raw reason string so automation is not parsing prose.

## Decision 4 — Exit code 2 for `none_dispatchable`

Exit `1` already means "the run did not reach a clean end" (a recorded stop or an
outstanding hold). `none_dispatchable` is a third outcome: the run ended cleanly but did no
work. Overloading `1` would make it indistinguishable from a stop for automation; leaving it
at `0` is the reported bug. A distinct `2` lets a caller branch on all three without parsing
JSON, while any existing caller that only tests `!== 0` treats "nothing ran" as
not-success — the safe reading.

`partial_excluded` keeps exit `0`: work did happen and the run resolved; the excluded items
are disclosed on the CLI line and in the JSON. Escalating that to non-zero would break the
ordinary "loop finished the ready items, the rest are untriaged" flow.

## Edge cases

- **Empty work list** (zero items): resolves with `dispatched: 0`, `excluded: 0` →
  `completion: "all_done"`, exit `0`. `none_dispatchable` requires ≥1 excluded item, so a
  vacuous run is not reported as a failure. Selector-level "no items matched" remains the
  preflight's concern, not the terminal summary's.
- **All items already done on a resumed run**: ledger-derived `dispatched` counts them, so
  a resume that drives zero cycles of new work still reports `all_done`.
- **Stop / hold**: unchanged reporting and exit `1`; `completion: null`. The accounting
  fields are still populated (best-effort counts from the ledger) so a stopped run's summary
  is not less informative than before.
