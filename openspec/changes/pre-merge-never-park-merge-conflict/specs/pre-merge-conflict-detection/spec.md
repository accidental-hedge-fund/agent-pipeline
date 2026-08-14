## MODIFIED Requirements

### Requirement: Early-conflict rebase attempt is bounded by a rebase-attempted guard

The pre-merge gate SHALL apply the same attempt-bound (stage-attempt ledger first;
legacy worktree marker only as non-authority cache) to the early-conflict rebase
path as it does to the CI-failure rebase path, so that a PR whose conflict cannot
be resolved does not loop indefinitely attempting a clean rebase on each poll
iteration. A bound that records a clean auto-rebase miss SHALL escalate to the
bounded conflict-resolution path (deterministic resolver and/or configured
implementer), and SHALL NOT call `setBlocked` with `BlockerKind` `merge-conflict`
and a “manual rebase needed” reason as the first-conflict terminal.

#### Scenario: First conflict detection attempts rebase

- **WHEN** the pre-merge gate detects CONFLICTING mergeability on the first poll iteration
- **AND** no rebase has been attempted yet for this head / worktree under the bound
- **THEN** the gate SHALL invoke the auto-rebase path (`tryRebaseAndPush` or equivalent)
- **AND** if the rebase succeeds SHALL record the attempt
- **AND** SHALL return `status: "waiting"` with reason "rebase-resolved; CI re-running"
  (or equivalent non-blocked re-enter-CI outcome)

#### Scenario: Rebase already attempted — blocks instead of looping

- **WHEN** the pre-merge gate detects CONFLICTING mergeability
- **AND** a clean auto-rebase has already been attempted for this head under the bound
  (ledger claim or equivalent)
- **THEN** the gate SHALL NOT invoke unlimited clean `tryRebaseAndPush` loops
- **AND** SHALL enter the bounded conflict-resolution path while the managed worktree
  is kept (escalation, not silent no-op)
- **AND** SHALL NOT call `setBlocked` with a clear “merge conflict — manual rebase needed”
  reason solely because the clean auto-rebase bound was hit
- **AND** SHALL NOT return `status: "blocked"` solely for that clean-bound hit while
  resolution budget remains

---

### Requirement: Auto-rebase failure emits a clear conflict-specific block reason

When the early-conflict or post-CI conflict path invokes clean auto-rebase and that
rebase cannot complete without conflict resolution, the pre-merge gate SHALL NOT
treat that single failure as a human terminal. The gate SHALL keep the managed
worktree and run bounded conflict resolution. Only after resolution budget
exhaustion with a still-conflicting tree MAY the gate block — and then with a
product / engine-owned failure that names conflict files and still identifies the
unresolved merge conflict as the structural cause, **not** with `BlockerKind`
`merge-conflict` and the text “manual rebase needed.”

#### Scenario: Auto-rebase fails — block reason names merge conflict

- **WHEN** the pre-merge gate invokes clean auto-rebase via the early-conflict or
  post-CI conflict path
- **AND** the rebase stops with conflicts (clean auto-rebase returns failure)
- **AND** resolution budget remains
- **THEN** the gate SHALL NOT call `setBlocked` with a reason containing both
  “merge conflict” and “manual rebase needed” as that step’s terminal outcome
- **AND** SHALL keep the managed worktree for this issue
- **AND** SHALL enter bounded conflict resolution (deterministic and/or configured
  implementer) before any terminal block
- **AND** SHALL NOT return `status: "blocked"` with `reason: "merge conflict"` solely
  for that first clean auto-rebase failure
- **WHEN** later the bounded conflict-resolution budget is exhausted and the tree is
  still conflicting
- **THEN** the gate MAY call `setBlocked` with a product / engine-owned failure kind
  that is not `merge-conflict` “manual rebase needed”
- **AND** the blocked reason or evidence SHALL name the residual conflict file paths
  and identify unresolved merge conflict as the structural cause
- **AND** the legal terminal text SHALL NOT be
  “PR has a merge conflict with the base branch that could not be automatically
  rebased — manual rebase needed.”

---

### Requirement: Early-conflict rebase bounds SHALL use the stage-attempt ledger

The pre-merge early-conflict rebase path SHALL bound attempts using the stage-attempt
ledger keyed by PR head SHA and rebase action, not by the presence of a worktree-local
`.pipeline-rebase-attempted` file as sole authority. First eligible conflict MAY attempt
clean rebase. An already-recorded clean-rebase attempt for the same head SHALL NOT
re-fire unlimited clean rebases; it SHALL escalate to bounded conflict resolution rather
than immediately blocking with a merge-conflict manual-rebase reason.

#### Scenario: First conflict on head H attempts rebase and claims the ledger

- **WHEN** the pre-merge gate detects CONFLICTING mergeability
- **AND** the ledger has no completed or started rebase attempt for the current head SHA `H`
- **THEN** the gate SHALL claim the rebase action for `H` and invoke clean auto-rebase
- **AND** SHALL NOT rely on creating `.pipeline-rebase-attempted` as the durable bound

#### Scenario: Ledger-recorded rebase attempt blocks loop without worktree marker

- **WHEN** the pre-merge gate detects CONFLICTING mergeability
- **AND** the ledger already records a clean rebase attempt for the current head SHA
- **AND** no `.pipeline-rebase-attempted` file is present
- **THEN** the gate SHALL NOT invoke unlimited clean `tryRebaseAndPush` again for that head
- **AND** SHALL enter bounded conflict resolution (or complete an in-progress resolve)
- **AND** SHALL NOT call `setBlocked` with a merge-conflict manual-rebase reason solely
  because the ledger already recorded that clean attempt

## ADDED Requirements

### Requirement: Pre-merge conflict resolution SHALL finish rebase, force-with-lease push, and re-enter pre-merge

When conflict resolution succeeds, pre-merge recovery SHALL complete the rebase in the
managed worktree, push the issue branch with `--force-with-lease`, and return a
non-blocked outcome that re-enters pre-merge CI / mergeability evaluation. The path
SHALL NOT apply `pipeline:blocked` solely because a conflict existed and was resolved.

#### Scenario: Successful resolve returns waiting for CI without blocked label

- **WHEN** clean auto-rebase hits conflicts and bounded resolution completes the rebase
- **AND** the force-with-lease push of the issue branch succeeds
- **AND** authoritative PR head has moved (or the path’s existing verified-head rules
  treat the recovery as successful)
- **THEN** the outcome SHALL be non-blocked (`status: "waiting"` or equivalent)
- **AND** the reason SHALL indicate rebase resolved and CI re-running (or equivalent)
- **AND** the issue SHALL NOT receive `pipeline:blocked` for `merge-conflict` for that success path

#### Scenario: Additive help-string union conflict class resolves without human park

- **WHEN** a hermetic fixture models a CONFLICTING PR whose conflicts are additive
  dual-side CLI help-string unions of the #1061 / #1064 class
- **AND** bounded resolution is injected to succeed
- **THEN** the recovery path SHALL complete push without calling `setBlocked` with
  `BlockerKind` `merge-conflict`
- **AND** the issue SHALL NOT end that recovery step with a `blocked` label for that reason

### Requirement: The #1061 manual-rebase park text is not a legal first-conflict terminal

The pre-merge conflict-recovery path SHALL NOT emit the terminal blocked reason
“PR has a merge conflict with the base branch that could not be automatically
rebased — manual rebase needed.” after a first clean auto-rebase conflict (or solely
because the clean-rebase ledger bound was hit). Automated tests SHALL fail if that
string is produced as the legal terminal for those cases.

#### Scenario: Regression rejects #1061 18:07Z-class terminal on first conflict

- **WHEN** unit tests exercise first clean auto-rebase conflict with resolution budget remaining
- **THEN** the recovery path SHALL NOT produce the exact legal terminal text used in the
  #1061 18:07Z park comment (“could not be automatically rebased — manual rebase needed”
  under `merge-conflict`)
- **AND** a regression test SHALL fail if that terminal is reintroduced for that case

### Requirement: Multi-item advance SHALL NOT abandon an item solely for first-conflict false park

While an item is in pre-merge conflict recovery (clean rebase miss → bounded resolve /
push / re-enter), multi-item advance / train SHALL NOT treat a first-conflict
`merge-conflict` human park as a completed disposition that alone authorizes starting
the next issue while this item remains unmerged because rebase was skipped.

#### Scenario: First-conflict recovery does not free the wave by false human park

- **WHEN** pre-merge hits a first clean auto-rebase conflict on item A
- **AND** resolution budget remains (or resolution is in progress / waiting)
- **THEN** the engine SHALL NOT apply a `merge-conflict` “manual rebase needed” park that
  alone causes multi-item advance to start item B while A is still unmerged solely
  because that park fired
- **AND** item A SHALL remain in engine-owned recovery or waiting rather than false human hold

### Requirement: Conflict resolution is class-level for pre-merge CONFLICTING and DIRTY paths

Both the early-conflict path and the post-CI mergeability re-check path that detect
true CONFLICTING or DIRTY mergeability SHALL share the same recovery law: clean
auto-rebase, then bounded resolve, then product-failure only on budget exhaust — never
first-conflict human manual-rebase park. A path-local fix of only one call site is
insufficient.

#### Scenario: Early-conflict and post-CI conflict share non-park recovery

- **WHEN** either the early-conflict gate or the post-CI CONFLICTING/DIRTY re-check
  routes to merge-conflict recovery
- **AND** clean auto-rebase fails with conflicts
- **THEN** both paths SHALL obey the non-park recovery law above
- **AND** neither path SHALL terminal-block with `merge-conflict` “manual rebase needed”
  on that first failure
