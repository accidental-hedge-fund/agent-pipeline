## Why

When the in-repo durable loop engine (#508) absorbed the standalone goal-loop core, it took a
deliberate shortcut on reconciliation: the `Reconciliation SHALL record caller-observed truth and
report drift without resolving it` requirement in `durable-loop-engine` accepts an observed-truth
document **supplied by the caller**, reads no external system itself, and never modifies item state
— it only reports mismatches. That was the right first cut to keep the port tractable, but it
leaves the engine's own ledger fields inert: `LoopReconciliation.observed` is typed `unknown`,
`last_reconciliation` / `reconciliation_sequence` / `last_native_goal_check` exist on the ledger but
nothing computes verified truth into them, and a `merged`/`pr_opened`/`released` ledger state can be
asserted by whatever the caller reports.

That is a correctness hole for a durable, cross-engine (Claude ↔ Codex), restart-surviving run: a
caller-supplied claim can drive a *remote-proving* transition it never actually proved. goal-loop#3
(this issue, #511) fixed this on the standalone core; this change ports the fix onto the integrated
durable ledger — verified live reconciliation, structured external identities, typed drift
classification with safe forward repair, and per-item next-action computation — while keeping the
engine's injected-seam, no-network **test** discipline intact.

## What Changes

- **Structured external identities.** Add a typed `LoopExternalIdentity` binding each item to the
  concrete external objects that can prove its state — issue number and open/ready-label state, PR
  number and PR state (`open`/`closed`/`merged`), head branch and head SHA, merge-commit SHA, and an
  aggregate CI checks conclusion (`success`/`failure`/`pending`/`none`) — plus the observation time.
  Replaces the free-form `observed: unknown` on the reconciliation record with this typed shape.
- **Verified live reconciliation.** Reconciliation observes the **live** GitHub / git / checks state
  through an engine-owned observation seam (typed `gh` / git wrappers), never from a caller-passed
  claim document. It records the observation as a monotonically sequence-numbered `last_reconciliation`
  and emits an event. Unit tests inject fakes for the seam, so the pass still performs **zero** real
  network, git, or subprocess calls.
- **Typed drift classification.** Every item whose ledger state disagrees with its verified external
  identity produces a drift record carrying exactly one member of a closed `LoopDriftClass` enum:
  `ledger-behind`, `ledger-ahead`, `external-absent`, `identity-mismatch`, or `checks-regressed`.
- **Safe drift repair.** Only benign catch-up drift (`ledger-behind` — the external truth is *ahead*
  of the ledger, e.g. the PR is observed merged while the ledger still says `pr_opened`) is repaired
  forward as an audited ledger transition. Every contradiction where the ledger over-claims an
  unproven remote state (`ledger-ahead`, `external-absent`, `identity-mismatch`) is **surfaced, never
  silently rewritten in either direction** — the engine records the conflict and routes the item to a
  human. Repair performs **no external mutation** — no merge, push, label write, or PR edit.
- **Caller-supplied state SHALL never prove a remote transition.** A transition **into** a
  remote-proving state (`pr_opened`, `ready`, `merged`, `released`, `deployed`) requires a fresh
  engine-verified external identity that supports it; a caller request lacking a matching live
  observation is refused, leaving durable state unchanged. Local states (`implemented`) are
  unaffected.
- **Next-action computation.** From the reconciled truth, reconciliation computes a single
  deterministic, pure typed next action per active item drawn from a closed `LoopNextAction` set
  (e.g. `advance`, `await-checks`, `repair-forward`, `clear-merge-barrier`, `hold-for-human`,
  `noop`) — identical inputs always yield the identical action.
- **Supersede the caller-observed reconciliation requirement.** The `durable-loop-engine`
  requirement `Reconciliation SHALL record caller-observed truth and report drift without resolving
  it` is retired and replaced by this capability. The merge-barrier requirement is unchanged: its
  clearing condition ("a reconciliation whose observed truth reports a base commit and includes the
  barrier's merged SHA") is now satisfied by verified live truth rather than a caller claim.

## Acceptance Criteria

- [ ] A typed `LoopExternalIdentity` binds each item to structured live external references (issue
  number + open/ready-label state, PR number + PR state, head branch, head SHA, merge-commit SHA,
  checks conclusion, observation time); the reconciliation record carries this typed identity and no
  free-form `observed: unknown` observation string remains on it.
- [ ] Reconciliation observes live GitHub / git / checks state through an engine-owned injected seam
  (not a caller-passed claim document), records a monotonically sequence-numbered `last_reconciliation`,
  and emits an event; a unit test drives it with fakes and asserts **zero** real network, git, and
  subprocess calls were recorded.
- [ ] Every drift record carries exactly one member of the closed `LoopDriftClass` enum
  (`ledger-behind`, `ledger-ahead`, `external-absent`, `identity-mismatch`, `checks-regressed`); a
  drift with no class or an out-of-enum class is impossible to construct (guarded by a runtime test,
  since types are stripped).
- [ ] Benign catch-up drift (`ledger-behind`) is repaired forward as an audited ledger transition
  that appends a history entry and emits an event; the repair records no external mutation (no merge,
  push, label write, or PR edit) through the injected seam.
- [ ] A contradiction where the ledger over-claims an unproven remote state (`ledger-ahead`,
  `external-absent`, or `identity-mismatch`) is surfaced as a recorded conflict and routes the item to
  a human next action; the ledger state is **not** silently rewritten in either direction.
- [ ] A transition into a remote-proving state (`pr_opened`, `ready`, `merged`, `released`,
  `deployed`) requested with no matching fresh verified external identity is refused, leaving durable
  state unchanged; the same transition backed by a supporting verified identity is accepted.
- [ ] Reconciliation computes a deterministic, pure typed next action per active item from the closed
  `LoopNextAction` set; running it twice on identical inputs yields byte-identical actions.
- [ ] The `durable-loop-engine` requirement `Reconciliation SHALL record caller-observed truth and
  report drift without resolving it` is removed and superseded by this capability, and the
  merge-barrier requirement still clears only on verified observed evidence.
- [ ] `node scripts/build.mjs` regenerates the plugin mirror and `npm run ci` (including
  `openspec validate --all`) is green; every new regression test bites (fails without the change).

## Capabilities

### New Capabilities
- `durable-run-reconciliation`: verified live reconciliation of a durable run's items against
  GitHub / git / checks truth — structured external identities, typed drift classification with safe
  forward-only repair, the invariant that caller-supplied state never proves a remote transition, and
  deterministic per-item next-action computation, all persisted through the durable ledger's
  reconciliation record and event log via engine-owned injected seams.

### Modified Capabilities
- `durable-loop-engine`: the `Reconciliation SHALL record caller-observed truth and report drift
  without resolving it` requirement is **removed** — superseded by `durable-run-reconciliation`, which
  reads live truth itself and repairs benign drift. The merge-barrier requirement is unchanged and now
  clears on verified live observation.

## Impact

- **Specs:** new `durable-run-reconciliation` capability; one removed requirement in
  `durable-loop-engine`.
- **Code (implementation step only, not this change):** `core/scripts/loop/types.ts`
  (`LoopExternalIdentity`, `LoopDriftClass`, `LoopNextAction`; retype `LoopReconciliation.observed` /
  `.drift`), a new reconciliation module (e.g. `core/scripts/loop/reconcile.ts`) that observes live
  truth through an engine-owned seam wrapping the existing typed `gh` wrappers
  (`getIssueStateAndLabels`, `getPrDetail`, `getPrMergeState`, `getPrChecks`, `getPrCommits`) plus a
  git head observation, classifies and forward-repairs drift, and computes next actions; the durable
  transition path (`loop/store.ts` / `loop/recovery.ts`) gains the remote-proving-transition guard;
  and the read-only status projection surfaces the latest reconciliation and per-item next action.
- **Interoperability:** additive to the ledger's already-present reconciliation fields; a run that
  has never reconciled behaves exactly as today (fields stay null). Legacy goal-loop import is
  unaffected — imported runs simply reconcile on their next pass. No new external write path and no
  auto-merge/auto-release/auto-deploy is introduced (golden rule #4).
