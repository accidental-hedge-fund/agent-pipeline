## ADDED Requirements

### Requirement: Settled CI failure at a head SHA SHALL not thrash rebase or unbounded partial waits

When required checks aggregate to **settled failure** — one or more definitive failures (`fail` / `cancel` or equivalent) and **no** pending checks — the pre-merge CI gate SHALL NOT re-enter a recovery path that claims a fresh rebase (or equivalent recovery side-effect) for the same head SHA after that recovery class’s one-shot budget for that SHA has already been consumed. After the applicable per-head recovery budget is exhausted, the gate SHALL call `setBlocked` with kind `ci-exhausted` (offramp class `ci-failed` on the blocked outcome), return `blocked`, and SHALL NOT return `waiting` solely because the same red tip is re-polled. This requirement tightens #181 / #679 against poll thrash when GitHub checks are already red.

#### Scenario: Settled failure with recovery budget exhausted blocks once

- **WHEN** `getPrChecks` returns one or more definitively failed checks and zero pending checks for head SHA `H`
- **AND** the per-head recovery budget for `H` is exhausted (rebase attempted, re-run/archive/assertion steps attempted or inapplicable)
- **THEN** the gate SHALL return `{ advanced: false, status: "blocked" }` with CI exhaustion classification
- **AND** SHALL call `setBlocked` with kind `ci-exhausted`
- **AND** SHALL NOT call `tryRebaseAndPush` again for `H` on subsequent polls while head remains `H`

#### Scenario: Multiple poll hops on the same red head do not repeat rebase side-effect

- **WHEN** unit tests inject settled `failure` checks at head `H` across two or more `advance` (or poll) hops
- **AND** the rebase recovery class has already been consumed for `H`
- **THEN** the fake `tryRebaseAndPush` seam SHALL record at most one invocation for `H`
- **AND** the second hop SHALL block rather than return `{ status: "waiting", reason: "rebased; CI re-running" }`

#### Scenario: Pending checks still wait (no false settle)

- **WHEN** `getPrChecks` reports at least one pending check for the head SHA
- **THEN** the gate SHALL return `{ advanced: false, status: "waiting" }` (e.g. reason `CI still running` or an equivalent pending wait)
- **AND** SHALL NOT treat the aggregate as settled failure solely because another check is red
- **AND** SHALL NOT call `setBlocked` for CI exhaustion on that pending tick

### Requirement: Waiting reason `rebased; CI re-running` SHALL require observable HEAD movement or explicit re-request

The gate SHALL return reason `rebased; CI re-running` only when a recovery side-effect **actually moved the PR head SHA** relative to the SHA observed when the recovery began, or when workflows were **explicitly re-requested** and checks remain pending. A no-op rebase (exit success without HEAD change) or a re-poll of the same red tip SHALL NOT use that reason. When a rebase is attempted for head `H` and HEAD does not move, the gate SHALL still consume the one-shot rebase budget for `H` and SHALL continue the remaining recovery ladder or escalate — it SHALL NOT return unbounded `waiting` with a false re-running claim.

#### Scenario: Rebase moves HEAD — wait for CI

- **WHEN** `getPrChecks` returns definitive failures for head SHA `H1`
- **AND** rebase has not yet been attempted for `H1`
- **AND** the rebase recovery side-effect succeeds and the PR head becomes a distinct SHA `H2`
- **THEN** the gate SHALL mark rebase attempted for the pre-move head (and/or new head per durable markers)
- **AND** SHALL return `{ advanced: false, status: "waiting", reason: "rebased; CI re-running" }`
- **AND** SHALL NOT call `setBlocked` on that tick

#### Scenario: Rebase succeeds but HEAD unchanged — do not claim re-running

- **WHEN** `getPrChecks` returns definitive failures for head SHA `H`
- **AND** rebase has not yet been attempted for `H`
- **AND** the rebase/push side-effect reports success but the PR head remains `H`
- **THEN** the gate SHALL consume the one-shot rebase budget for `H`
- **AND** SHALL NOT return reason `rebased; CI re-running`
- **AND** SHALL continue remaining recovery steps or escalate to `ci-exhausted` when no further steps apply
- **AND** a subsequent poll with the same head still red SHALL NOT invoke rebase again

#### Scenario: Explicit workflow re-request may wait without HEAD move

- **WHEN** classification selects the infra/unknown re-run path and the re-run seam successfully re-requests failed workflows for head `H`
- **THEN** the gate MAY return `waiting` with a reason that indicates CI was re-triggered
- **AND** SHALL NOT use the string `rebased; CI re-running` unless a rebase also moved HEAD

### Requirement: Rebase recovery budget SHALL be durable per head SHA

The one-shot rebase recovery for definitive CI failure SHALL be tracked against the PR head SHA in durable run state that survives process restart (the same durability class as re-run / archive-fail / assertion-fix markers under the pre-merge CI recovery store). Relying solely on a worktree-local marker that can be lost when the worktree is recreated SHALL NOT be sufficient to re-open unlimited rebase attempts for the same failed head. When durable marker persistence fails and the run directory is unavailable, the gate SHALL NOT return unbounded `waiting` on in-memory-only rebase state; it SHALL escalate with `ci-exhausted` naming the persistence failure (consistent with #679 marker durability).

#### Scenario: Durable rebase marker prevents re-rebase after process restart

- **WHEN** a rebase was already recorded as attempted for head SHA `H` in durable run state
- **AND** a new process resumes pre-merge with the same head SHA `H` still settled red
- **THEN** the gate SHALL NOT call `tryRebaseAndPush` again for `H`
- **AND** SHALL continue remaining budget steps or escalate

#### Scenario: New head SHA may receive its own one-shot rebase

- **WHEN** the PR head advances to a new SHA `H2` distinct from the SHA whose rebase budget was consumed
- **THEN** the gate SHALL allow at most one rebase attempt for `H2` under the same rules
- **AND** SHALL NOT treat “already rebased for `H1`” as permanent suppression for all future heads without re-evaluation

#### Scenario: Force-push back to a previously consumed head retains that head’s budget

- **WHEN** rebase budget was consumed for head SHA `H1` and later for a distinct head SHA `H2`
- **AND** the PR head is force-pushed back to `H1` (or otherwise returns to `H1`)
- **AND** a new process or empty polling context resumes pre-merge with durable run state for the same run directory
- **THEN** the gate SHALL NOT call `tryRebaseAndPush` again for `H1`
- **AND** SHALL retain `H1` (and `H2`) in the durable per-class recovery marker set rather than overwriting a single latest-SHA scalar

#### Scenario: Successful rebase with unverified post-rebase HEAD re-evaluates without escalating

- **WHEN** the rebase/push side-effect reports success for head SHA `H`
- **AND** the authoritative post-rebase `getPrDetail` head read fails or returns no SHA
- **THEN** the gate SHALL consume the one-shot rebase budget for `H`
- **AND** SHALL return `{ advanced: false, status: "waiting" }` with a re-evaluation reason (not `rebased; CI re-running`)
- **AND** SHALL NOT call `setBlocked` with kind `ci-exhausted` on that tick using the pre-rebase failed checks alone

### Requirement: Escalated settled CI failure SHALL emit a terminal CI gate_result fail

When the gate escalates from settled CI failure (budget exhausted), it SHALL record a durable `gate_result` for gate `ci` with `result: "fail"` (or the established blocked equivalent already used by pre-merge observability) including a reason that identifies CI failure. For a given failed head SHA after escalation, the gate SHALL NOT emit an unbounded sequence of `gate_result` rows with `result: "partial"` and reason `rebased; CI re-running` on pure re-polls that perform no new recovery side-effect.

#### Scenario: Block path writes ci fail once

- **WHEN** the gate returns `blocked` due to CI recovery budget exhaustion for head `H`
- **THEN** the run event stream SHALL contain a `gate_result` with `gate: "ci"` and `result: "fail"`
- **AND** the reason SHALL name CI failure and/or failing checks sufficiently for operators

#### Scenario: Pure re-poll of unchanged red head does not spam partial rebased rows

- **WHEN** head SHA `H` is settled red and rebase budget for `H` is already consumed
- **AND** a poll performs no new recovery side-effect and escalates or remains blocked
- **THEN** the run SHALL NOT append additional `gate_result` rows with `result: "partial"` and reason `rebased; CI re-running` for that re-poll

#### Scenario: Terminal ci fail is idempotent per failed head SHA

- **WHEN** the gate has already recorded a terminal `gate_result` `ci`/`fail` for head SHA `H`
- **AND** a pure re-poll observes the same head still settled red with recovery budgets exhausted
- **THEN** the gate SHALL NOT append another terminal `ci`/`fail` solely for that re-poll
- **AND** SHALL still return `blocked` (not unbounded `waiting`)

#### Scenario: Terminal ci fail remains idempotent when only runDir is provided

- **WHEN** `advance` is invoked with a run directory and without an in-memory `pollingCtx`
- **AND** the gate has already recorded a terminal `gate_result` `ci`/`fail` for head SHA `H` in durable run state
- **AND** a subsequent invocation observes the same head still settled red with recovery budgets exhausted
- **THEN** the gate SHALL NOT append another terminal `ci`/`fail` solely for that re-poll
- **AND** SHALL still return `blocked`

### Requirement: Settled-check aggregate SHALL be pending-first for the current PR head

The pre-merge CI gate SHALL evaluate settlement using the checks returned for the PR at poll time against the **current** PR head SHA from `getPrDetail`. Any pending check (bucket not `pass`/`skipping`/`fail`/`cancel`) SHALL take precedence over failure: the gate SHALL return `waiting` and SHALL NOT enter definitive-failure recovery or `ci-exhausted` while pending remains. Neutral/skipped (`skipping`) checks SHALL NOT count as failure or pending. Immediately after a settled-failure check poll and before entering definitive-failure recovery, the gate SHALL re-read `getPrDetail`; if the head SHA differs from the SHA observed when the poll began, the gate SHALL return `waiting` without recovery side-effects so the next tick re-evaluates the new head.

#### Scenario: Red plus pending waits without recovery

- **WHEN** `getPrChecks` reports at least one failed check and at least one pending check for the current PR head
- **THEN** the gate SHALL return `{ status: "waiting" }`
- **AND** SHALL NOT call `tryRebaseAndPush` or other definitive-failure recovery side-effects on that tick
- **AND** SHALL NOT call `setBlocked` with kind `ci-exhausted`

#### Scenario: Concurrent head change during check poll skips recovery

- **WHEN** `getPrChecks` returns settled failure for the head SHA observed when the poll began (`H1`)
- **AND** a re-read of `getPrDetail` immediately after that poll reports a distinct head SHA `H2`
- **THEN** the gate SHALL return `{ status: "waiting" }` (re-evaluation / head-advanced wait)
- **AND** SHALL NOT call `tryRebaseAndPush` or other definitive-failure recovery side-effects on that tick
- **AND** SHALL NOT consume per-head recovery budget markers for `H1` on that tick
- **AND** SHALL NOT call `setBlocked` with kind `ci-exhausted` on that tick

### Requirement: CI recovery persistence failure SHALL fail closed

When the durable CI recovery marker store cannot be written or read-back-verified before a recovery side-effect that would consume budget, the gate SHALL refuse that side-effect and SHALL escalate with `ci-exhausted` naming the persistence failure rather than returning unbounded `waiting` on in-memory-only state. This applies to rebase as well as re-run / archive / assertion classes.

#### Scenario: Marker write failure refuses side-effect and blocks

- **WHEN** settled failure would authorize a recovery class attempt for head `H`
- **AND** persisting the per-class attempt marker fails or runDir is unavailable
- **THEN** the gate SHALL NOT perform that recovery side-effect (or SHALL not claim a successful recovery wait after an undurable attempt)
- **AND** SHALL escalate with `ci-exhausted` including a durable-persistence failure signal in the operator reason

### Requirement: Escalation evidence SHALL include failing checks and optional capped logs

When escalating settled CI failure, the block reason SHALL name each failing check. A log excerpt SHALL be included only when retrieval succeeds and SHALL be size-capped. Failure to fetch logs SHALL NOT prevent blocking and SHALL NOT cause additional recovery waits.

#### Scenario: Log fetch failure still blocks with check names

- **WHEN** recovery budget is exhausted for head `H` with settled failed checks
- **AND** log excerpt retrieval returns null or throws
- **THEN** the gate SHALL still call `setBlocked` with kind `ci-exhausted`
- **AND** the reason SHALL list failing check names
- **AND** SHALL return `blocked`

## MODIFIED Requirements

### Requirement: CI failure with rebase guard exhausted blocks to needs-human

When CI check runs are definitively failing (not pending), the pre-merge gate SHALL first apply the bounded recovery ladder defined by the "bounded CI recovery budget" requirements in this capability. Only after that budget is exhausted for the current head SHA SHALL the gate call `setBlocked` and return `blocked`. When escalating, the gate SHALL use blocker kind `ci-exhausted` (not a bare generic `needs-human` without classification) and a reason that names each failing check. It SHALL NOT return unbounded `waiting` solely because checks are red, and SHALL NOT re-enter an archive/poll spin loop (#181 non-regression). A successful one-shot rebase SHALL return `waiting` with reason `rebased; CI re-running` **only when the PR head SHA actually changed** as a result of that rebase; a no-op rebase that leaves HEAD unchanged SHALL consume the one-shot rebase budget for that head SHA and continue the ladder or escalate rather than thrash on that reason.

#### Scenario: CI failing, recovery budget exhausted — block immediately

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** the per-head-SHA recovery budget for this head is exhausted (rebase policy applied as configured, re-run already attempted or inapplicable, archive-only recovery already attempted or inapplicable, assertion auto-fix already attempted or disabled/inapplicable)
- **THEN** the gate SHALL call `setBlocked` with kind `ci-exhausted` and a reason listing the failing check names
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "CI failed" }` (or an equivalent blocked reason that identifies CI exhaustion)
- **AND** SHALL NOT return `waiting` or attempt another automatic recovery for the same head SHA

#### Scenario: CI failing, first rebase succeeds and moves HEAD — wait for CI to re-run

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** rebase has not yet been attempted for the current head SHA
- **AND** the rebase recovery side-effect succeeds **and** the PR head SHA changes
- **THEN** the gate SHALL mark the rebase as attempted for that head (durable per-head marker)
- **AND** SHALL return `{ advanced: false, status: "waiting", reason: "rebased; CI re-running" }`
- **AND** SHALL NOT call `setBlocked` on that tick

#### Scenario: CI failing, rebase attempt fails — continue recovery ladder (not instant generic block)

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** rebase has not yet been attempted for the current head SHA
- **AND** the rebase recovery side-effect fails (rebase or push could not complete)
- **THEN** the gate SHALL NOT treat rebase failure alone as the end of all recovery when further budget steps remain (classification / re-run / archive-aware recovery / optional assertion fix)
- **AND** when no further recovery step applies, SHALL escalate with `ci-exhausted` as in the budget-exhausted scenario

#### Scenario: CI failing, rebase no-op (HEAD unchanged) — consume budget, do not thrash wait

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** rebase has not yet been attempted for the current head SHA
- **AND** the rebase/push side-effect reports success but the PR head SHA does not change
- **THEN** the gate SHALL mark rebase as attempted for that head SHA
- **AND** SHALL NOT return `{ status: "waiting", reason: "rebased; CI re-running" }`
- **AND** SHALL continue the recovery ladder or escalate when budget is exhausted
