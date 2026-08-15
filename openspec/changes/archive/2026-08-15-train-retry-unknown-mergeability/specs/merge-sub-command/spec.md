## MODIFIED Requirements

### Requirement: The `merge` sub-command SHALL verify PR mergeability before merging

The merge handler SHALL read PR mergeability via `gh pr view <pr>` (or the
injected `ghPrView` seam) including at least `mergeable`, `mergeStateStatus`,
and `headRefOid` before proceeding to later gates or the squash merge.

When the latest read reports `mergeable: "UNKNOWN"` (GitHub has not yet
computed mergeability), the handler SHALL **not** treat that as a terminal
refusal on the first observation. It SHALL re-read under a bounded budget
defined by named constants:

- `MERGEABILITY_UNKNOWN_MAX_ATTEMPTS = 5` total mergeability reads (the initial
  read **counts** toward the budget);
- `MERGEABILITY_UNKNOWN_RETRY_DELAY_MS = 5000` fixed delay between consecutive
  UNKNOWN reads (at most 4 sleeps for a full budget).

The delay SHALL be injectable for tests so unit tests do not wall-clock wait.

The handler SHALL sleep and re-read **only** when `mergeable === "UNKNOWN"`.
Any other non-success classification (`CONFLICTING`, `DIRTY`, `BEHIND`,
`BLOCKED`, `HAS_HOOKS`, `MERGEABLE` with non-`CLEAN` status, or any other
non-`MERGEABLE`/`CLEAN` combination that is not the pure UNKNOWN compute gap)
SHALL refuse immediately on that read with **zero** sleep and without further
UNKNOWN-budget consumption.

The handler SHALL proceed to the checks gate only when a successful read reports
`mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"`. The head SHA used for
`--match-head-commit` SHALL come from the same successful MERGEABLE+CLEAN read
that passed the mergeability gate — never from an earlier UNKNOWN read.

The handler SHALL refuse to merge and exit non-zero (or throw to the caller)
with an actionable message when:

- after the retry budget is exhausted, mergeability is still `UNKNOWN`; or
- any read reports a hard unclean state as above.

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
- **AND** the second read within the budget returns `mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"` with a distinct `headRefOid`
- **THEN** the handler SHALL proceed to the checks gate (and subsequent gates) using the head SHA from the **second** (successful) read
- **AND** it SHALL NOT exit non-zero solely because the first read was UNKNOWN
- **AND** a unit test with injected deps and fake sleep SHALL assert exactly two mergeability reads, one sleep of `MERGEABILITY_UNKNOWN_RETRY_DELAY_MS`, and one merge using the second head SHA

#### Scenario: Unknown mergeability state is refused

- **WHEN** every mergeability read within the bounded attempt budget returns `mergeable: "UNKNOWN"` (GitHub never computes a definite state in budget)
- **THEN** the handler SHALL perform exactly `MERGEABILITY_UNKNOWN_MAX_ATTEMPTS` mergeability reads and `MAX_ATTEMPTS - 1` sleeps
- **AND** the handler SHALL exit non-zero (or throw) with an actionable message that mergeability is still UNKNOWN / not yet computed and advising wait/retry
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
