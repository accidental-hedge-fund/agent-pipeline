## MODIFIED Requirements

### Requirement: The `merge` sub-command SHALL verify PR mergeability before merging

The merge handler SHALL read PR mergeability via `gh pr view <pr>` (or the
injected `ghPrView` seam) including at least `mergeable`, `mergeStateStatus`,
and `headRefOid` before proceeding to later gates or the squash merge.

When the latest read reports `mergeable: "UNKNOWN"` (GitHub has not yet
computed mergeability), the handler SHALL **not** treat that as a terminal
refusal on the first observation. It SHALL wait a short deterministic delay and
re-read mergeability under a **bounded** attempt budget (a fixed small maximum
attempt count with short sleeps between attempts, on the order of several
attempts over tens of seconds). The delay SHALL be injectable for tests so unit
tests do not wall-clock wait.

The handler SHALL proceed to the checks gate only when a successful read reports
`mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"`. The head SHA used for
`--match-head-commit` SHALL come from the same successful read that passed the
mergeability gate.

The handler SHALL refuse to merge and exit non-zero (or throw to the caller)
with an actionable message when:

- after the retry budget is exhausted, mergeability is still `UNKNOWN`; or
- any read reports a hard unclean state (`CONFLICTING`, `DIRTY`, `BEHIND`,
  `BLOCKED`, `HAS_HOOKS`, or any non-`MERGEABLE`/`CLEAN` combination that is not
  the UNKNOWN compute gap).

The handler SHALL **never** treat `UNKNOWN` as `MERGEABLE` and SHALL **not**
invoke the squash merge while the latest successful mergeability classification
in the attempt loop is still UNKNOWN.

#### Scenario: Mergeable clean PR proceeds to next gate

- **WHEN** `gh pr view` returns `mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"`
- **THEN** the handler proceeds to the checks gate and does not exit

#### Scenario: Conflicted PR is refused

- **WHEN** `gh pr view` returns `mergeable: "CONFLICTING"` or `mergeStateStatus: "DIRTY"`
- **THEN** the handler SHALL exit non-zero with a message identifying the conflict condition and SHALL NOT merge
- **AND** the handler SHALL NOT burn the UNKNOWN retry budget as a path to a successful merge for that observation

#### Scenario: Transient UNKNOWN then MERGEABLE succeeds within budget

- **WHEN** the first mergeability read returns `mergeable: "UNKNOWN"`
- **AND** a later re-read within the bounded attempt budget returns `mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"`
- **THEN** the handler SHALL proceed to the checks gate (and subsequent gates) using the head SHA from the successful read
- **AND** it SHALL NOT exit non-zero solely because the first read was UNKNOWN
- **AND** a unit test with injected deps and fake sleep SHALL assert at least two mergeability reads and no premature merge refusal

#### Scenario: Unknown mergeability state is refused

- **WHEN** every mergeability read within the bounded attempt budget returns `mergeable: "UNKNOWN"` (GitHub never computes a definite state in budget)
- **THEN** the handler SHALL exit non-zero (or throw) with an actionable message that mergeability is still UNKNOWN / not yet computed and advising wait/retry
- **AND** the handler SHALL NOT invoke `gh pr merge`

#### Scenario: UNKNOWN is never treated as MERGEABLE

- **WHEN** the latest mergeability classification for the current attempt is `UNKNOWN`
- **THEN** the handler SHALL NOT invoke the squash merge on that attempt
- **AND** it SHALL only squash after a later read reports `MERGEABLE` and `CLEAN` (or fail closed after budget exhaustion)

## ADDED Requirements

### Requirement: Mergeability UNKNOWN retry SHALL use injectable delay

The merge handler’s UNKNOWN re-read loop SHALL wait between attempts via an
injected sleep/delay seam on the merge dependency interface (or an equivalent
test-injectable delay passed into `mergePr`). Production deps MAY use a real
timer. Unit tests SHALL supply a fake delay that records calls without
wall-clock waiting. The attempt budget and delay constants SHALL be deterministic
and named so tests can pin attempt counts.

#### Scenario: Unit test controls retry timing

- **WHEN** a unit test injects a fake sleep and a sequence of UNKNOWN then MERGEABLE+CLEAN mergeability reads
- **THEN** the handler SHALL call the fake sleep between UNKNOWN attempts
- **AND** SHALL complete successfully without real `setTimeout` wall-clock delay
- **AND** SHALL NOT make real network, git, or subprocess calls
