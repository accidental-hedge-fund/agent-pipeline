## Context

The integrated durable loop engine (#508) persists a per-item state machine, an append-only event
log, an append-only decision log, and a ledger that *already declares* reconciliation fields —
`last_reconciliation: LoopReconciliation | null`, `reconciliation_sequence: number`,
`last_native_goal_check`, and a `merge_barrier` cleared only "by a reconciliation whose observed
truth reports a base commit and includes the barrier's merged SHA". But nothing computes those
fields from real truth. Today's `durable-loop-engine` requirement is explicit about the shortcut:

> **Reconciliation SHALL record caller-observed truth and report drift without resolving it** — "The
> engine SHALL accept an observed-truth document supplied by the caller and SHALL NOT read GitHub or
> any other external system itself … and SHALL NOT modify item states to match the observation."

That was a deliberate first cut. **This change intentionally supersedes it** (surfaced per the
project's conflict-visibility rule rather than blended): goal-loop#3 / #511 ports the verified
reconciliation the standalone core carried. `LoopReconciliation.observed` is `unknown` and
`.drift[]` is a bare `{ item_id, ledger_state, observed_state }` triple — both are placeholders this
change gives real shape.

## Goals / Non-Goals

**Goals**
- Verified live truth: reconciliation reads GitHub / git / checks itself (through an engine-owned
  seam), so a caller can never substitute a claim for proof.
- Structured external identities: a typed binding of each item to the concrete objects that prove
  its state, replacing `observed: unknown`.
- Typed drift classification with **safe forward-only** repair; every over-claim surfaced, never
  silently resolved.
- Deterministic, pure per-item next-action computation.

**Non-Goals**
- No external **mutation** of any kind — reconciliation and repair are read-plus-ledger-write only.
  No merge, push, label write, PR edit, release, or deploy (golden rule #4; the pipeline never
  merges).
- No change to the per-item advance state machine (labels / `BlockerKind`); this is the durable
  *run* engine, a distinct surface.
- No new *lock* or run-directory artifact — reconciliation writes only the existing ledger
  reconciliation fields and an event.
- No real network / git / subprocess in unit tests — the live read is an **injected seam**, so the
  "verified" guarantee is about *provenance* (engine-owned live read vs. caller claim), not about
  bypassing the test discipline.

## Decisions

### Verified truth = engine-owned live read through a seam, not a caller claim
The core inversion vs. #508: the observed-truth document is no longer a parameter the caller passes;
it is produced by an engine-owned `ReconcileObserveDeps` seam that wraps the existing typed `gh`
wrappers (`getIssueStateAndLabels`, `getPrDetail`, `getPrMergeState`, `getPrChecks`, `getPrCommits`)
plus a git head observation. Unit tests inject a fake seam, so the pass records zero real calls while
the *provenance* of the truth is the live remote — never a caller's assertion. This is exactly what
"caller-supplied state must never prove a remote transition" requires: the only thing that can move
an item into a remote-proving state is the engine's own verified observation.

### Structured external identity is the unit of proof
`LoopExternalIdentity` binds an item to: `issue_number` + `issue_open` + `ready_label_present`;
`pr_number` + `pr_state` (`open`|`closed`|`merged`|`null`); `head_branch`; `head_sha`;
`merge_commit_sha | null`; `checks_conclusion` (`success`|`failure`|`pending`|`none`); and
`observed_at`. Field shapes are confirmed against the real `gh --json` outputs the existing wrappers
already parse (golden rule #5) — no guessed field names. Each remote-proving ledger state maps to the
identity fact that proves it: `pr_opened` ⇐ a live PR exists on the item's head; `merged` ⇐
`pr_state === "merged"` (or the merge SHA present in the base); `ready` ⇐ the ready-to-deploy label
observed on the issue; `released`/`deployed` ⇐ their recorded external markers.

### Drift is a closed typed set; only forward catch-up auto-repairs
`LoopDriftClass` = `ledger-behind` | `ledger-ahead` | `external-absent` | `identity-mismatch` |
`checks-regressed`. The repair rule is asymmetric on purpose:
- **`ledger-behind`** (external ahead of a proven ledger claim — e.g. PR observed `merged` while the
  ledger says `pr_opened`): the external truth is authoritative and strictly forward, so the engine
  applies the catch-up transition as an audited repair (history entry + event). This is the only
  auto-repair.
- **`ledger-ahead` / `external-absent` / `identity-mismatch`** (the ledger asserts a remote-proving
  state the verified identity does **not** support — a `merged` ledger with an open PR, a `pr_opened`
  ledger with no PR, or a PR/head SHA that differs from what the ledger bound): the higher state was
  never actually proven, but the engine also must not *guess* the true state by silently demoting
  (that could erase a real merge observed a beat later). So it records the conflict drift, leaves the
  ledger untouched, and routes to a human — matching the spirit of the retired "report, don't resolve"
  rule but now with verified truth and a typed class.
- **`checks-regressed`** (checks that were `success` are now `failure`/`pending` on the observed
  head): advisory drift; next action routes to `await-checks` or a human hold, never a silent rewrite.

### Next action is pure and deterministic
`computeNextAction(item, identity, ledger)` returns exactly one `LoopNextAction` —
`advance` | `await-checks` | `repair-forward` | `clear-merge-barrier` | `hold-for-human` | `noop` —
from the reconciled inputs alone. No clock read, randomness, or I/O inside it, so the same inputs
always yield the same action and the function is trivially unit-testable and drift-guardable.

### The remote-proving guard lives on the transition path, composed with existing gates
A transition into `pr_opened`/`ready`/`merged`/`released`/`deployed` is refused (validation class,
state unchanged) unless a fresh verified `LoopExternalIdentity` supporting it is present. This
composes with — never replaces — the existing "Gated transitions SHALL require directly verified
evidence" and authority-gate requirements: authority governs *whether the run may* take the step;
this guard governs *whether the remote actually did*. Both must hold.

### Reuse the existing reconciliation fields; no new ledger surface
The pass writes only `last_reconciliation` (now typed), bumps `reconciliation_sequence`, and appends
an event via the existing `appendEvent` primitive under the lock token. No second ledger, no new log,
no new lock — consistent with `durable-loop-store`'s one-contract/one-ledger/one-event-log invariant.

## Risks / Trade-offs

- **Retiring a shipped requirement.** Removing the caller-observed reconciliation requirement is a
  behavior change; mitigated by keeping the merge-barrier requirement's clearing contract identical
  (verified truth is a strict superset of a caller claim) and by additive ledger fields (a
  never-reconciled run is unchanged).
- **Surface-not-demote on over-claim.** Choosing to surface `ledger-ahead`/`external-absent` to a
  human rather than auto-demote trades some autonomy for safety: it never erases a real transition
  the observation merely missed. Accepted — a durable cross-engine run must fail closed on
  contradictory truth.
- **Freshness of the verified identity.** The remote-proving guard requires a *fresh* observation;
  the freshness window is a small bounded constant (mirroring the native-goal freshness window) so a
  stale identity cannot rubber-stamp a transition. Chosen constant is documented in the spec scenario.
