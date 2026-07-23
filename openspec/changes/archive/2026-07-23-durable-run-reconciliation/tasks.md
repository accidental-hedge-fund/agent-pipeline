## Tasks

## 1. Structured external identity & reconciliation types
- [x] 1.1 Add `LoopExternalIdentity` to `core/scripts/loop/types.ts` (`issue_number`, `issue_open`,
      `ready_label_present`, `pr_number: number | null`, `pr_state: "open" | "closed" | "merged" |
      null`, `head_branch`, `head_sha`, `merge_commit_sha: string | null`, `checks_conclusion:
      "success" | "failure" | "pending" | "none"`, `observed_at`).
- [x] 1.2 Add the closed `LoopDriftClass` enum (`ledger-behind`, `ledger-ahead`, `external-absent`,
      `identity-mismatch`, `checks-regressed`) plus an `isLoopDriftClass` guard.
- [x] 1.3 Add the closed `LoopNextAction` enum (`advance`, `await-checks`, `repair-forward`,
      `clear-merge-barrier`, `hold-for-human`, `noop`) plus an `isLoopNextAction` guard.
- [x] 1.4 Retype `LoopReconciliation`: `observed` becomes `Record<string, LoopExternalIdentity>` and
      `drift[]` gains a typed `class: LoopDriftClass` per entry; add an optional per-item
      `next_action: LoopNextAction`.

## 2. Verified live observation seam
- [x] 2.1 Add a `ReconcileObserveDeps` seam (engine-owned) wrapping the existing typed `gh` wrappers
      (`getIssueStateAndLabels`, `getPrDetail`, `getPrMergeState`, `getPrChecks`, `getPrCommits`) and
      a git head observation — confirm each `gh --json` field shape against real output before coding
      against it (golden rule #5).
- [x] 2.2 Implement `observeExternalIdentity(deps, repo, item)` returning a `LoopExternalIdentity`
      built only from live reads.

## 3. Reconciliation pass (verified truth → drift → repair)
- [x] 3.1 Add `reconcile(deps, runId, token, observeDeps)` in a new `core/scripts/loop/reconcile.ts`:
      read the ledger, observe every item's live identity, and write a typed, sequence-numbered
      `last_reconciliation` (bump `reconciliation_sequence`) via the store, emitting a reconciliation
      event under the lock token.
- [x] 3.2 Classify each disagreeing item into exactly one `LoopDriftClass`; a drift with no/invalid
      class is unconstructable (runtime-guarded).
- [x] 3.3 Repair **only** `ledger-behind` forward as an audited ledger transition (history entry +
      event); leave every over-claim (`ledger-ahead`/`external-absent`/`identity-mismatch`) untouched
      and recorded as a conflict routed to a human.
- [x] 3.4 Assert repair performs **no** external mutation — no merge, push, label write, or PR edit
      recorded through the injected seam.
- [x] 3.5 Keep merge-barrier clearing behavior intact: the barrier clears only when the verified
      observation reports a base commit that includes the barrier's merged SHA.

## 4. Caller-supplied state never proves a remote transition
- [x] 4.1 On the durable transition path (`loop/store.ts` / `loop/recovery.ts`), refuse a transition
      into a remote-proving state (`pr_opened`, `ready`, `merged`, `released`, `deployed`) unless a
      fresh verified `LoopExternalIdentity` supporting it is supplied — validation class, state
      unchanged.
- [x] 4.2 Compose with (never bypass) the existing authority-gate and directly-verified-evidence
      requirements; local states (`implemented`) are unaffected.

## 5. Next-action computation
- [x] 5.1 Add a pure `computeNextAction(item, identity, ledger)` returning one `LoopNextAction`; no
      clock, randomness, or I/O.
- [x] 5.2 Surface the latest reconciliation and per-item next action in the read-only status
      projection (`getStatus`) — no writes, no lock, no GitHub call.

## 6. Modified durable-loop-engine
- [x] 6.1 Remove the `Reconciliation SHALL record caller-observed truth and report drift without
      resolving it` requirement (superseded by `durable-run-reconciliation`); confirm the
      merge-barrier requirement is unchanged and still clears on verified observed evidence.

## 7. Tests & gates
- [x] 7.1 Fixture tests (injected seams, no real network/git/subprocess): identity build from live
      reads; sequence-numbered reconciliation; every `LoopDriftClass` produced on its trigger; forward
      repair applied and no-external-mutation asserted; over-claim surfaced not rewritten;
      remote-proving-transition guard allow/deny matrix; deterministic next-action.
- [x] 7.2 Assert the reconciliation pass records **zero** real network/git/subprocess calls through
      the injected seam.
- [x] 7.3 Prove each regression test bites (fails without the change).
- [x] 7.4 Regenerate the plugin mirror (`node scripts/build.mjs`) and run `npm run ci` green,
      including `openspec validate --all`.
