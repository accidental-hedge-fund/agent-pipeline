## ADDED Requirements

### Requirement: Local test-gate fail rows SHALL be SHA-matched before blocking the live head

When `cfg.ci_mode` is `"local"`, the pre-merge CI gate SHALL read the most-recent test-gate outcome and its `pr_head_sha` as today. A recorded **failure** SHALL authorize a local-mode block or suite-fail disposition only when `pr_head_sha` equals the live open PR head. When `pr_head_sha` differs from the live head, or is absent (legacy), the gate SHALL NOT treat that failure as certification that the live head failed: it SHALL fail closed against using the stale row as live-head fail authority (no advance on a stale pass remains as already specified) and SHALL require a fresh test-gate result for the live head (or an explicit blocked reason that the live head lacks current local certification) rather than replaying `test-gate-exhausted` text keyed only to the old SHA.

#### Scenario: Stale failure for prior head does not fail local mode for new head

- **WHEN** `cfg.ci_mode` is `"local"`
- **AND** the most-recent test-gate outcome is a failure with `pr_head_sha = H_fail`
- **AND** the live PR head is `H_green` where `H_green ≠ H_fail`
- **THEN** the gate SHALL NOT call `setBlocked` solely with a suite-fail / `test-gate-exhausted` reason that only names the prior-head failure as current
- **AND** SHALL NOT advance on that stale failure row as if it were a pass

#### Scenario: Current-head failure still blocks local mode

- **WHEN** `cfg.ci_mode` is `"local"`
- **AND** the most-recent test-gate outcome is a failure with `pr_head_sha` equal to the live PR head H
- **THEN** the gate SHALL NOT advance
- **AND** SHALL call `setBlocked` with a reason that names the failed local test gate and head H under existing local-mode failure contracts

#### Scenario: Stale pass still fail-closed (non-regression)

- **WHEN** `cfg.ci_mode` is `"local"`
- **AND** the most-recent test-gate outcome is a pass whose `pr_head_sha` does not match the live PR head
- **THEN** the gate SHALL still block with `needs-human` under the existing stale-pass rule
- **AND** SHALL NOT treat the earlier pass as certification of the current head

---

### Requirement: GitHub-mode green checks on the live head SHALL outrank superseded local fail narrative

When `cfg.ci_mode` is `"github"` and `getPrChecks` (or equivalent) reports definitive success for the live open PR head H, the pre-merge CI step SHALL treat H as CI-green for gate purposes even if run-local `tester_evidence` or `stage_accounting` test-gate rows record a failure for a different SHA A ≠ H. Those superseded fail rows SHALL NOT alone divert the CI step into `ci-exhausted` / suite-fail block for H. Pending or failed checks on H continue under existing recovery and exhaustion requirements for H.

#### Scenario: Green github checks on live head ignore prior-head local fail

- **WHEN** `cfg.ci_mode` is `"github"`
- **AND** checks for live head `H_green` are successful
- **AND** run-local test-gate or tester-evidence fail rows name only `H_fail ≠ H_green`
- **THEN** the CI step SHALL proceed as green for `H_green` under existing post-green mergeability / OpenSpec steps
- **AND** SHALL NOT return `blocked` solely from the prior-head local fail rows

#### Scenario: Failed checks on live head still enter recovery

- **WHEN** `cfg.ci_mode` is `"github"` and checks for live head H are definitively failing
- **THEN** the gate SHALL enter the existing per-head recovery ladder for H
- **AND** SHALL NOT skip recovery because a different historical SHA had green checks
