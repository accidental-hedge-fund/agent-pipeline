## Why

The in-repo durable loop engine (#508) records bounded recovery state — a free-text
`blocked_theme`, per-theme recovery budgets, and a consecutive-blocked stop limit — but leaves
blocker *diagnosis* and recovery *selection* to the outer agent. Because the budget key is an
arbitrary theme string and no policy constrains what recovery is attempted, two failure modes
remain open: an unrecognized or ambiguous blocker can be retried under a made-up theme, and an
item can consume its whole budget re-attempting the *same* failure without ever proving progress.
Porting goal-loop#1's typed hard-block classification into the integrated engine closes both.

## What Changes

- Introduce a closed, machine-readable `DurableBlockerClass` enum covering every structurally
  distinct durable-run failure: `transient-rate-limit`, `workflow-state`, `implementation-ci`,
  `environment-auth`, `specification-decision`, `missing-authority`, `upstream-dependency`, and
  `workflow-engine-defect`. Every durable-run block into the `blocked` state SHALL carry exactly
  one class; the recorded theme becomes the class name.
- Add a machine-readable, validated **recovery policy** that maps each class to its permitted
  recovery recipes, retry/backoff budget, and terminal outcome. The policy is compiled into the
  contract; a missing or malformed class entry fails validation.
- **Fail closed** on unknown or ambiguous blockers: a blocker that does not map to exactly one
  class records a terminal needs-human stop and consumes no recovery budget.
- **Fingerprint blocker evidence** and bound repeated no-progress: a repeated identical evidence
  fingerprint on the same item is counted, and once the configured repeat limit is reached the run
  stops terminally even if the class budget still has room.
- Re-key recovery budgets from the free-text theme to the typed blocker class (**BREAKING** to the
  internal budget-keying contract; the theme→class rename is transparent to legacy-run import,
  which maps an imported theme onto its class).
- Keep recovery **authority-safe**: no recovery recipe performs a merge, release, credential, or
  deploy action; the `missing-authority` and `specification-decision` classes route to a terminal
  human-authority outcome rather than a retry recipe, reinforcing the engine's existing authority
  gates.
- Persist per-attempt classification, attempted recovery actions, evidence fingerprint, and
  outcome in the ledger, and emit Pipeline-native events for each.
- On successful recovery, **resume the same item** (`blocked`→`in_progress`); allow
  dependency-independent items to continue when the blocking class's policy is non-run-fatal.

## Acceptance Criteria

- [ ] A closed `DurableBlockerClass` enum defines all eight classes (`transient-rate-limit`,
  `workflow-state`, `implementation-ci`, `environment-auth`, `specification-decision`,
  `missing-authority`, `upstream-dependency`, `workflow-engine-defect`) and every durable-run
  transition into `blocked` carries exactly one of them.
- [ ] A machine-readable recovery policy maps every class to its permitted recovery recipes,
  retry/backoff budget, and terminal outcome; validation fails closed when any class entry is
  missing or malformed, and no class is left without an entry.
- [ ] An unknown or ambiguous blocker fails closed: the run records a terminal needs-human stop
  and consumes no recovery budget.
- [ ] Recovery budgets are keyed by the item's typed blocker class (not a free-text theme); an
  exhausted class budget stops the run terminally.
- [ ] Identical evidence fingerprints repeated on the same item are bounded: after the configured
  repeat limit the run stops terminally even when the class budget still has room.
- [ ] No recovery recipe performs a merge, release, credential, or deploy action; the
  `missing-authority` and `specification-decision` classes route to a terminal human-authority
  outcome instead of a retry recipe.
- [ ] The ledger persists, per recovery attempt, the classification, the attempted recovery
  actions, the evidence fingerprint, and the outcome; a Pipeline-native event is emitted for each.
- [ ] After a successful recovery the same item resumes (`blocked`→`in_progress`) rather than
  restarting from scratch or being skipped.
- [ ] Dependency-independent eligible items continue while an item is blocked when the blocking
  class's policy is non-run-fatal; a run-fatal class stops the whole run.
- [ ] Fixture tests cover every blocker class, recovery-budget exhaustion, repeated evidence,
  successful same-item resume, and safe independent-item continuation, using injected seams with
  no real network, git, or subprocess calls.

## Capabilities

### New Capabilities
- `durable-blocker-classification`: the typed durable-run blocker enum, the machine-readable
  recovery policy (permitted recipes, retry/backoff budgets, terminal outcomes per class),
  evidence fingerprinting with repeated-no-progress bounding, fail-closed handling of unknown /
  ambiguous blockers, authority-safe recovery, ledger/event persistence of classification and
  outcome, same-item resume, and safe independent-item continuation.

### Modified Capabilities
- `durable-loop-engine`: the recovery-budget requirement is re-keyed from the recorded free-text
  blocked theme to the item's typed blocker classification.

## Impact

- **Specs:** new `durable-blocker-classification` capability; one modified requirement in
  `durable-loop-engine`.
- **Code (implementation step only, not this change):** `core/scripts/loop/types.ts`
  (`DurableBlockerClass`, recovery-policy and recovery-attempt types), the durable transition
  engine / `core/scripts/loop/store.ts` (classification-keyed budgets, fingerprint counting,
  fail-closed path, event emission), and `core/scripts/loop/import.ts` (theme→class mapping for
  legacy-run import).
- **Interoperability:** budget keying moves from theme to class; legacy goal-loop runs are
  imported by mapping the recorded theme onto its class.
