## ADDED Requirements

### Requirement: Worktree lifecycle decisions SHALL go through one reconcile-and-converge surface

The engine SHALL provide a single worktree lifecycle reconcile surface that observes authoritative
managed-worktree state and returns ordered actions to converge toward the invariant. Observed state
SHALL include at least: managed record presence or absence, dirty workdir, local-only (unpushed)
commits, path/branch identity versus the expected issue/slug, and poisoned or mismatched tree
conditions (wrong revision / wrong branch / corrupted registration). Returned actions SHALL be drawn
from a closed set including retain, rematerialize/recreate, salvage-then-continue, refuse-unsafe-
remove, and safe-remove-then-recreate. Call sites that today independently decide reusable-vs-
recreate SHALL invoke this surface (or a thin wrapper) rather than re-encoding the policy tree.

#### Scenario: Missing managed worktree yields rematerialize action

- **WHEN** reconcile observes no managed worktree for the issue and the stage requires one
- **THEN** it SHALL return a rematerialize/recreate action
- **AND** SHALL NOT park solely for absence without evaluating rematerialize when policy permits

#### Scenario: Dirty worktree refuses unsafe remove

- **WHEN** reconcile observes a managed worktree with dirty porcelain and no force authority
- **THEN** it SHALL return refuse-unsafe-remove (or retain) rather than force-remove
- **AND** SHALL NOT emit a safe-remove action that bypasses `evaluateRemoveSafety`

#### Scenario: Poisoned or mismatched tree does not proceed on the wrong revision

- **WHEN** reconcile observes a managed path whose HEAD or branch identity does not match the
  expected issue candidate (poisoned/mismatched)
- **THEN** it SHALL return repair/rematerialize or refuse actions that prevent stages from running
  against the wrong revision
- **AND** SHALL NOT return retain-as-healthy for that observation (#769 class)

#### Scenario: Stale clean worktree may be reclaimed only when safety allows

- **WHEN** reconcile observes a clean managed worktree with no local-only commits that is stale
  relative to the desired path/slug
- **THEN** it MAY return safe-remove-then-recreate
- **AND** any remove action SHALL be gated by `evaluateRemoveSafety`

---

### Requirement: Review-verdict currency SHALL be a reconcile input rather than stage-local terminalization

Review-currency reconcile SHALL produce reuse / re-review / hold dispositions from authoritative
observed evidence rather than stage-local terminalization side paths. Observed evidence includes
reviewed SHA, current HEAD, pipeline-internal commit classification, diff-hash cache, blocking keys
and overrides, and finding/recurrence/ceiling evidence bound to the current pipeline run, candidate
lineage, and an actual intervening fix attempt. Review/fix round counts, finding fingerprints, and
recurrence evidence SHALL be reconciler inputs, not independent authority to apply
`pipeline:needs-human`.

#### Scenario: Recurrence evidence without human-decision authority does not create a human hold

- **WHEN** reconcile observes exact-key recurrence or review-ceiling exhaustion for the current
  candidate with engine-owned `review-findings` evidence
- **AND** no current `human-decision-required` authority diagnostic is present
- **THEN** it SHALL NOT converge to a human hold solely from recurrence or ceiling counts
- **AND** SHALL emit recovery/reconcile actions compatible with the autonomous recovery controller
  (#626 / #675 class)

#### Scenario: Unresolved blocking keys at a current verdict hold the gate without inventing authority

- **WHEN** the current reviewed SHA matches HEAD (or is valid under pipeline-internal / diff-hash
  reuse rules)
- **AND** recorded blocking keys remain un-overridden
- **THEN** reconcile SHALL keep the issue blocked at pre-merge for those keys
- **AND** SHALL NOT invent a product `human-decision-required` diagnostic solely from the key list

#### Scenario: Recurrence requires intervening fix and candidate lineage

- **WHEN** recurrence evidence is not bound to the current pipeline run, candidate lineage, and an
  actual intervening fix attempt
- **THEN** reconcile SHALL NOT treat that evidence as authoritative exact recurrence
- **AND** SHALL NOT suppress a fresh fix opportunity solely from unbound history

---

### Requirement: Reconcile SHALL follow the OpenSpec active-change guard shape

Worktree and review reconcile surfaces SHALL follow the same structural pattern as
`enforceOpenspecActiveChangeGuard`: derive true state from authoritative sources (PR head tree /
live candidate / managed worktree registration), decide actions that repair toward the invariant,
and fail closed when observation fails. They SHALL NOT trust stale path lists, host-local markers,
or free-form prose as primary truth when authoritative observation is available.

#### Scenario: Observation failure fails closed

- **WHEN** authoritative observation required for worktree or review reconcile cannot be obtained
- **THEN** the surface SHALL return a typed fail-closed blocker or refuse-unsafe action
- **AND** SHALL NOT proceed as if the invariant already holds

#### Scenario: Authoritative tip wins over stale local inference

- **WHEN** host-local inference disagrees with freshly observed PR head or managed worktree
  registration
- **THEN** reconcile SHALL prefer the authoritative observation
- **AND** SHALL derive actions from that observation

---

### Requirement: Child-stage repair and supervisor recovery SHALL share attempt identity

Child-stage repair attempts and supervisor recovery claims SHALL share ledger identity for the same
candidate, finding, and action so process restart cannot suppress, duplicate, or bypass recovery.
Fresh reconciliation MUST preserve a recoverable `blocked` state over bare open-PR existence and
MUST drive every `started` attempt to a completed, failed, or explicitly superseded outcome. Only
current `human-decision-required` authority evidence may converge to a human hold.

#### Scenario: Bare open PR does not supersede a started recovery claim

- **WHEN** a recovery or stage repair attempt is `started` for a candidate
- **AND** fresh observation finds only that an open PR still exists without verified ready/merged
  truth
- **THEN** reconcile SHALL NOT clear the blocked/recoverable state solely from bare open-PR existence
- **AND** SHALL retain the started attempt for completion, failure, or explicit supersession

#### Scenario: Shared identity prevents duplicate charge after restart

- **WHEN** a child-stage repair claimed `(candidate, finding, action)` and the process restarts
- **AND** the supervisor re-enters recovery for the same identity
- **THEN** hydration SHALL recognize the existing claim
- **AND** SHALL NOT create a second charged attempt that bypasses or doubles the budget

#### Scenario: Human hold requires current authority evidence

- **WHEN** reconcile considers converging to a human hold
- **THEN** it SHALL require current `human-decision-required` authority evidence
- **AND** mechanical exhaustion, recurrence, or ceiling alone SHALL NOT satisfy that requirement

---

### Requirement: Live and manual invocation coexistence SHALL not corrupt reconcile authority

Concurrent live pipeline invocation and manual operator actions on the same issue/PR SHALL not
corrupt ledger authority or force unsafe worktree removal. Reconcile SHALL re-observe live state
before destructive actions and SHALL refuse removals that fail `evaluateRemoveSafety` even when a
prior in-process decision assumed a clean tree (#770 class).

#### Scenario: Manual dirtying after observe refuses remove

- **WHEN** reconcile previously planned a safe remove based on a clean observation
- **AND** before mutation the worktree becomes dirty (manual or concurrent write)
- **THEN** the remove path SHALL re-check safety (non-force remove or re-evaluate)
- **AND** SHALL refuse destruction of the newly dirty work

#### Scenario: Manual HEAD movement rebinds currency

- **WHEN** an operator force-pushes or amends the PR head between reconcile ticks
- **THEN** the next reconcile SHALL bind review currency and attempt keys to the new head
- **AND** SHALL NOT apply old-head attempt suppression or verdict reuse incorrectly without
  re-evaluation rules
