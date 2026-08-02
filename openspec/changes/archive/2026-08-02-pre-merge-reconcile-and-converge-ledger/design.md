## Context

PR #787 shipped the outer autonomous recovery controller: candidate-bound claims before side
effects, durable started-attempt charging, bounded budgets and backoff, crash reconciliation,
deterministic-first recipes, and redispatch through normal gates. PR #814 fixed the immediate
v1.29.2 review-recovery split (artifact-bound child-run lineage, repair evidence, blocked-claim
preservation).

What remains is **stage-local authority fragmentation**:

| Mechanism | Examples | Failure mode |
| --- | --- | --- |
| Worktree marker file | `.pipeline-rebase-attempted` | Leaks into salvage commits; host-local only |
| runDir JSON | `pre-merge-ci-recovery.json` | Host-local; not shared with supervisor claims |
| GH comment sentinels | autofix-attempt / autofix-noop | Parallel book vs run ledger |
| Commit-subject prefixes | autofix / archive inference | Ambiguous authority |
| In-memory flags | `noRunRecoveryAttemptedForSha`, `repairAttempted` | Lost on resume; duplicated sites |

Worktree lifecycle decisions are similarly scattered (~11 reusable-vs-recreate sites). Removal
has six call paths; only some climb the `evaluateRemoveSafety` ladder (`auto_recover` and
`deploy_ready` force-remove unguarded — #622 data-loss precedent). `releaseWorktreeForParkedIssue`
can evaluate the same policy twice.

The one subsystem already in the right shape is `enforceOpenspecActiveChangeGuard`: derive true
state from the PR head tree, repair toward the invariant, fail closed. #759 generalizes that
shape and unifies attempt authority with the shipped recovery ledger.

**Boundary:** #761/#787 own scheduling and recipe execution. This change owns authoritative state
consolidation and converge-to-invariant behavior. Review routing reuses the #814 `review-findings`
class; it does not reimplement review policy.

## Goals / Non-Goals

**Goals:**

- One durable attempt ledger as the sole production authority for stage-local one-shots and
  shared supervisor claims, extending the #787 recovery-attempt record.
- One reconcile-and-converge API shape for worktree lifecycle and review-verdict currency.
- Every worktree removal through `evaluateRemoveSafety` or an explicit written exemption.
- Cross-host-safe hydration using GitHub-authored attestation where host-local state is insufficient
  (same disposition as CLAUDE.md §#459 / papercut auto-file).
- Idempotent claim → execute → complete across process restart; every `started` attempt reaches
  completed, failed, or explicitly superseded.
- Behavior-freeze: consolidate structure without inventing new recovery recipes or widening
  authority.

**Non-Goals:**

- New recovery recipes or automation beyond consolidating existing attempts (#761/#787).
- Full pre_merge god-file split implementation body (#628) — only require reconcile-shaped
  surfaces that #628's modules should expose.
- Auto-merge, unattended merge, credential entry, override/authority expansion.
- Replacing the OpenSpec active-change guard's product outcomes — only generalizing its *shape*.
- Reimplementing review recurrence/ceiling policy (#814 owns routing; this owns ledger/converge).

## Decisions

### 1. Extend the #787 recovery-attempt record — do not invent a second ledger

**Choice:** Stage-local actions write and read the same attempt-record family the autonomous
recovery controller already persists (item, candidate identity, evidence fingerprint, action,
outcome, budget, `not_before` / `next_attempt_at`, last error). Add explicit fields required by
the issue upsert: action status, typed reason (#760 vocabulary where applicable), attempt budget
remaining, idempotency key, and terminal outcome. Provide a thin `stage-attempt-ledger` API
(`hydrate`, `claim`, `complete`, `supersede`, `hasAttempted`) used by pre-merge and worktree
callers so they never open private JSON files or in-memory-only books.

**Rejected:** A parallel `pre-merge-ci-recovery.json` v2 or a separate stage ledger schema. That
preserves the split-brain the issue is closing.

**Rejected:** Making GH comments the only store. Comments are excellent cross-host attestation
and MAY be written as evidence, but authority is the ledger hydration that *reads* durable
sources (run events + attested comments + commit subjects as migration inputs), not ad-hoc
sentinel scans scattered in callers.

### 2. Key space: `(headSha, action)` plus candidate/run binding

**Choice:** Minimum production key for stage one-shots is `(headSha, action)` as the issue states.
Supervisor-shared actions also bind item, run/candidate lineage, and evidence fingerprint so
child-stage repair and outer recovery claims cannot diverge. When HEAD moves, prior head keys
remain historical; the new head has a fresh budget unless a supersession rule explicitly copies
state (e.g. pre-archive green evidence retained as diagnostic, not as free re-fire of the same
action on the old SHA).

**Rejected:** Worktree-path-only keys (host-local, not PR-head authoritative).
**Rejected:** Issue-only keys without SHA (allows infinite re-fire after external HEAD movement
looks like a new attempt, or permanent suppression after a single fire).

### 3. Reconcile-and-converge is pure observation → ordered actions

**Choice:** Introduce a pure (or deps-injected) `reconcile(observed) → { actions, blockers }`
layer for:

1. **Worktree lifecycle** — observed: managed record existence, dirty porcelain, local-only
   commits, path/branch identity vs expected issue/slug, poisoned/mismatched tree (#769).
   Actions: retain, rematerialize, salvage-then-continue, refuse-unsafe-remove, recreate-after-
   safe-remove. Removal always consults `evaluateRemoveSafety` once.
2. **Review-verdict currency** — observed: reviewed SHA, pipeline-internal commits, diff-hash
   cache, blocking keys/overrides, finding fingerprints, recurrence/ceiling evidence bound to
   current run and intervening fix. Actions: reuse verdict, delta re-review, full re-review,
   hold-for-unresolved-keys, emit `review-findings` recovery input. Never: independent
   `needs-human` terminalization without current `human-decision-required` authority.

Callers (pre-merge facade, worktree helpers, supervisor re-entry) execute returned actions
through existing seams; they do not re-derive the policy tree ad hoc.

**Model:** `enforceOpenspecActiveChangeGuard` — tip-tree truth over path lists; repair toward
invariant; fail closed on observation failure.

**Rejected:** Keeping ~11 independent if/else recreate sites with copied dirty/local-only checks.
**Rejected:** Folding recipe execution into reconcile (that is #787's controller).

### 4. Removal safety is a single ladder with explicit exemptions

**Choice:** Every production path that removes a managed worktree MUST call
`evaluateRemoveSafety` (directly or via one shared wrapper such as `removeWorktreeForIssue` /
parked-release that already evaluates once). Sites that today call `removeWorktree` without the
ladder (`auto_recover`, `deploy_ready`, and any other) either:

- route through the ladder, or
- carry a written exemption comment naming why terminal force-remove is safe *and* a regression
  test that asserts the exemption remains intentional.

Parked release evaluates the policy **once** per decision; no dual independent preflight that
can disagree.

### 5. Marker retirement is authority retirement, not necessarily byte erasure day-one

**Choice:**

| Old mechanism | After this change |
| --- | --- |
| `.pipeline-rebase-attempted` | Engine SHALL NOT write it as attempt state. Salvage exclusion remains defense-in-depth for legacy dirt. Ledger records rebase attempts. |
| `pre-merge-ci-recovery.json` | No longer required authority. Migration MAY read once into the ledger then ignore. New writes go to the ledger. |
| Autofix comment sentinels | MAY continue as cross-host attestation written *by* the ledger claim path; callers MUST NOT treat sentinel scan alone as the attempt book. |
| Commit-subject prefixes | Migration/hydration input only; not sole authority. |
| In-memory flags | Allowed as a cache of ledger state within a process; not durability. |

### 6. Pre-merge modules expose reconcile, not only linear gates

**Choice:** Align with #628's intended split: domain modules (SHA-gate, OpenSpec, CI, conflict)
SHOULD expose `reconcile(state) → actions` entry points that the facade sequences. This change
does not implement the full move-only split if unfinished, but new consolidation code lands
behind reconcile-shaped surfaces so #628 does not re-encode linear-only gates.

### 7. Cross-host authority for raw and durable entry points

**Choice:** Raw single-issue advance and durable loop entry both hydrate attempt state from the
same ledger API. Where host-local runDir is missing (other host), hydration falls back to
GitHub-authored attestation (attested comments / commit subjects / PR head) consistent with
existing cross-host-safe patterns. Host-local files never win over fresher GitHub-attested
terminal outcomes for the same key.

### 8. Testing strategy

- Injected `deps` only — no real network/git/subprocess in unit tests (repo convention).
- Prove marker retirement: fakes assert no write of `.pipeline-rebase-attempted` / no required
  read of `pre-merge-ci-recovery.json` for authority.
- Restart fixtures: claim `started` → crash → hydrate → complete without double charge.
- Removal graph test: static or runtime registry of removal call sites vs ladder/exemption.
- #626 exact-key recurrence and #675 ceiling fixtures feed reconciler inputs; assert no
  human hold without authority diagnostic.
- #769 rematerialize/poisoned tree and #770 coexistence as reconcile scenarios.

## Risks / Trade-offs

- **[Risk] Migration gaps leave dual authority briefly** → Mitigation: single read API that
  merges legacy sources once, then writes only to the ledger; tests fail if callers read legacy
  files for authority after migration helpers exist.
- **[Risk] Over-generalizing reconcile rewrites SHA-gate policy** → Mitigation: behavior-freeze;
  existing review-SHA and CI recovery suites remain oracles; only authority *source* and
  convergence *shape* change.
- **[Risk] Force-remove exemptions become silent data-loss holes** → Mitigation: every exemption
  needs a comment + regression test; default is ladder.
- **[Risk] Confusing this layer with recipe scheduling** → Mitigation: explicit boundary docs in
  specs; reconcile returns actions, controller/#787 executes recipes.
- **[Risk] Performance from extra GH reads for hydration** → Mitigation: hydrate once per gate
  entry; cache in process; prefer run-event ledger when present.

## Migration Plan

1. Land ledger API + record field extensions with tests against fakes.
2. Point CI recovery, rebase, autofix, and OpenSpec repair attempt sites at the ledger; keep
   dual-read migration for one release of dogfood if needed, dual-write forbidden for new keys
   once ledger write succeeds.
3. Stop writing `.pipeline-rebase-attempted`; keep salvage exclude.
4. Route unguarded removals through the ladder; add exemptions only where proven safe.
5. Introduce worktree + review reconcile helpers; rewire call sites incrementally behind tests.
6. Delete dead marker loaders when no production reader remains; regenerate `plugin/`; `npm run ci`.

Rollback: feature is structural. Revert the PR restores prior markers; no data migration of
GitHub comments is required for rollback.

## Open Questions

- Whether autofix attestation comments remain permanently as cross-host evidence or become
  optional once run-event ledger is always present for durable entry — default: keep attestation
  writes for raw advance hosts without a durable run dir.
- Exact #760 typed-reason enum membership for stage actions (rebase, ci-rerun, archive-fail-
  recovery, assertion-fix, openspec-repair, worktree-rematerialize) — implement against the
  closed set shipped with #760 if already in tree; otherwise define additive stage-action reasons
  under the ledger capability without inventing a second top-level diagnostic enum.
