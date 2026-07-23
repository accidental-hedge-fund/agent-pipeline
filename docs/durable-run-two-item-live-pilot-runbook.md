# Durable-run two-item live pilot — runbook (#515)

_Capability: `durable-run-two-item-live-pilot`. Tier 2 of the pilot (see
`openspec/changes/durable-run-two-item-live-pilot/design.md` — Tier 1 is the hermetic
composition simulation at `core/test/durable-run-two-item-live-pilot.test.ts`)._

This is the operator-facing procedure for running the **real** two-item durable-loop pilot
against a live GitHub repository, and the evidence-bundle contract the completed run must
satisfy to be judged done. It exercises exactly the same five behaviors the hermetic simulation
proves deterministically — a recoverable blocker, a same-item resume, the merge-refresh barrier,
derived evidence reporting, and no duplicate external action — but against real `gh`/git state and
a real human merge.

The pipeline never merges (CLAUDE.md golden rule #4). Step 6 below is a human action; the pilot
only observes it.

## Prerequisites

- A GitHub repository the operator can push to and open PRs against (a scratch repo or a
  low-stakes corner of a real one — this pilot files real issues/PRs).
- `pipeline:loop` installed and runnable against that repository (see this repo's own
  `pipeline:loop` skill/CLI).
- Two GitHub issues filed ahead of time:
  - **Item A** — any small, mechanically completable change.
  - **Item B** — declares an `external_depends_on` edge on item A's issue number in its durable-loop
    discovery input (however the operator's discovery/compile step is invoked — e.g. a contract
    override or an explicit dependency annotation on the issue).
- `max_active_items: 1` (the contract's fixed default — no override needed).

## Procedure

1. **Compile and start the run.** Start `pipeline:loop` against the two-item selector so it
   compiles a contract with item A (no dependencies) and item B (`external_depends_on: [A]`).
   Confirm via `pipeline:loop audit <run-id>` (or equivalent) that both items are `pending` and
   the contract's `max_active_items` is `1`.

2. **Let the supervisor drive item A.** The supervisor selects A (the only externally-unblocked
   pending item), starts it, and dispatches it into the per-item Pipeline advance loop. Confirm via
   the audit view that A is `in_progress` and B is still `pending`.

3. **Induce a recoverable blocker on A.** While A is `in_progress`, induce a real recoverable
   condition — the simplest reproducible choice is **`implementation-ci`**: push a commit to A's
   branch that fails CI, or **`transient-rate-limit`**: throttle/rate-limit the `gh`/GitHub API
   calls the running process makes (e.g. via a temporary low-quota token). Confirm the ledger
   records A `blocked` with the expected `DurableBlockerClass`, and that the run itself did **not**
   stop (a recoverable class's policy is non-`run_fatal`).

4. **Recover and resume.** Address the induced condition (fix CI / restore API quota), then run the
   engine's recovery entry point for A (`recoverItem` — invoked via whatever `pipeline:loop`
   CLI surface wraps it, e.g. an unblock/retry command) followed by `pipeline:loop resume` (or the
   equivalent `driveSupervisor(..., { resume: true })` invocation). Confirm:
   - the action-evidence trail gained a `resume` entry,
   - A continued as the **same** item (its ledger history shows exactly one `blocked -> in_progress`
     recovery transition, no second `pending -> in_progress` start),
   - a reconciliation pass ran on resume.

5. **Let A reach `ready`.** The resumed run redispatches A; once its PR passes checks and carries
   the `pipeline:ready-to-deploy` label, the ledger shows A `ready`. Confirm B is still ineligible:
   `pipeline:loop audit` (or a direct look at the ledger) should show B `pending`, blocked on A's
   external dependency being `pending` (A's PR not yet merged).

6. **A human merges A's PR.** This is the one step in the whole run a human performs, never the
   pipeline. Merge A's PR through the normal GitHub UI/CLI.

7. **Resume/observe the merge.** Run the next reconciliation pass (the supervisor's own periodic
   cycle, or an explicit `pipeline:loop resume`/audit trigger). Confirm:
   - A's ledger state repairs forward from `ready` to `merged` — driven by the reconciliation pass
     observing the merge through the engine-owned seam, never by any caller-supplied claim,
   - B's external dependency status flips to `satisfied`,
   - B becomes eligible and is started on that same reconciliation cycle (subject to
     `max_active_items: 1`).

8. **Let B run to `ready`, and the run to terminal.** Confirm the supervisor drives B through to
   `ready` and the whole run reports `allDone` (or the operator's chosen `done_definition`) with no
   stop record.

9. **Capture the evidence bundle** (see contract below) and **link it from issue #515**.

## Evidence-bundle artifact contract

The captured evidence bundle for the live run MUST include, for each of the five exercised
behaviors:

| Behavior | Required artifact |
|---|---|
| Recoverable blocker | The ledger `history` entry for item A's `blocked` transition, showing its `theme` (the `DurableBlockerClass`) and evidence excerpt; the `recovery_attempts` entry recording the recovery outcome (`recovered`). |
| Same-item resume | The action-evidence trail entry with `action: "resume"`; item A's ledger `history` showing exactly one `blocked -> in_progress` transition (no second `pending -> in_progress` start for A). |
| Merge-refresh barrier | The sequence-numbered reconciliation record (from the run's events log, `kind: "loop_reconciled"`) at which A's PR is first observed `merged`; item A's `last_verified_identity` showing `pr_state: "merged"`; item B's ledger `history` showing its `pending -> in_progress` start occurs no earlier than that reconciliation's timestamp. |
| Evidence reporting | The full set of artifacts above, assembled into one bundle (not a prose summary) referencing the ledger, the action-evidence timeline, and the reconciliation records directly. |
| No duplicate external action | A count, over the whole run, of external-mutating calls (PR opens, label writes, merges) per item, showing exactly one PR and one merge for A and exactly one PR for B — no duplicates from the crash/resume or from any redundant reconciliation pass. |

The bundle also records the run's terminal condition (all items done, `stop: null`) and the run id,
so a reviewer can independently pull the raw ledger/events/action-evidence for verification.
