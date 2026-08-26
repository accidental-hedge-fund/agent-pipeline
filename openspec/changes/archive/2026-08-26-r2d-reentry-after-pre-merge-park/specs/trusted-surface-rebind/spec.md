## ADDED Requirements

### Requirement: Trusted-surface candidate SHA SHALL resolve without a managed worktree when an authoritative later-stage pin exists

When a verification-relevant run computes a trusted-surface decision and no managed worktree is on disk for the issue, the engine SHALL still resolve `candidate_sha` from an authoritative source instead of failing closed solely because the worktree is absent. Resolution order SHALL be:

1. Worktree HEAD when a managed worktree is present (existing path).
2. Else an explicit candidate-SHA override from the advance `--sha` command input (or an equivalent production caller field), when it is a full 40-character hexadecimal SHA.
3. Else the head SHA of the linked open pull request, when that head is a full 40-character hexadecimal SHA and it matches the last-advanced candidate pin when that pin is present.

The last-advanced candidate pin is the SHA last recorded as the product candidate this issue successfully advanced under (review SHA-gate pin, last successful pre-merge candidate, or last non-sentinel trusted-surface `candidate_sha` for the issue). Recency SHALL be the persisted trusted-surface decision timestamp or successful pre-merge event `at`, not the originating run's `run_start` or run-id time. When that pin is absent and a linked open PR head is a full 40-hex SHA, the engine SHALL use that PR head. When the pin is present and the PR head differs, the engine SHALL NOT use the PR head.

This fallback SHALL apply at least when the issue stage is at or after `pre-merge`. It SHALL NOT invent a candidate SHA from harness prose, reviewer free text, or an all-zero sentinel.

When a candidate SHA is resolved this way, the engine SHALL still compute (or reuse a SHA-matched durable) trusted-surface decision for that SHA. It SHALL NOT treat missing path information as silent `passthrough`. If the decision cannot be computed or reused for the resolved SHA, the outcome SHALL be `blocked` with a named reason other than inventing a trusted hash.

#### Scenario: matching PR head after park supplies candidate SHA

- **WHEN** issue N is at or after `pre-merge` and has no managed worktree on disk
- **AND** a linked open PR exists whose head SHA H is a full 40-character hex SHA
- **AND** H equals the last-advanced candidate pin, or that pin is absent
- **THEN** the trusted-surface decision `candidate_sha` SHALL be H
- **AND** the decision SHALL NOT use reason code `worktree_unavailable` solely because the worktree is absent

#### Scenario: explicit override supplies candidate SHA

- **WHEN** issue N has no managed worktree on disk
- **AND** an explicit candidate-SHA override S is a full 40-character hex SHA
- **AND** if a linked open PR exists, S equals that PR head
- **THEN** the trusted-surface decision `candidate_sha` SHALL be S
- **AND** the decision SHALL NOT use reason code `worktree_unavailable` solely because the worktree is absent

#### Scenario: production advance --sha override supplies candidate SHA

- **WHEN** issue N has no managed worktree on disk
- **AND** the operator supplied `--sha S` on the advance command, where S is a full 40-character hexadecimal SHA
- **AND** if a linked open PR exists, S equals that PR head
- **THEN** the trusted-surface decision `candidate_sha` SHALL be S
- **AND** the decision SHALL NOT use reason code `worktree_unavailable` solely because the worktree is absent

#### Scenario: absent worktree and absent PR fails closed with a named outcome

- **WHEN** issue N is at or after `pre-merge` and has no managed worktree on disk
- **AND** no explicit candidate-SHA override is present
- **AND** no linked open PR with a resolvable head SHA exists
- **THEN** the trusted-surface decision outcome SHALL be `blocked`
- **AND** the reason SHALL be a named code (not an invented SHA)
- **AND** readiness composition SHALL NOT treat that run as a trusted-surface pass

#### Scenario: mismatched PR head is not accepted as the candidate

- **WHEN** issue N has no managed worktree on disk
- **AND** a last-advanced candidate pin P is present
- **AND** the linked open PR head H is a full 40-character hex SHA
- **AND** H is not equal to P
- **THEN** the trusted-surface decision outcome SHALL be `blocked`
- **AND** `candidate_sha` SHALL NOT be set to H
- **AND** readiness composition SHALL NOT use H as the readiness subject

#### Scenario: newest durable pin wins when an older run matches the PR head

- **WHEN** issue N has no managed worktree on disk
- **AND** more than one prior durable last-advanced record exists
- **AND** an older record's SHA equals the linked open PR head H
- **AND** a newer record's SHA P differs from H
- **THEN** the last-advanced candidate pin SHALL be P
- **AND** the trusted-surface decision outcome SHALL be `blocked`
- **AND** `candidate_sha` SHALL NOT be set to H

#### Scenario: mismatched override is not accepted

- **WHEN** issue N has no managed worktree on disk
- **AND** an explicit candidate-SHA override S is present
- **AND** a linked open PR exists whose head H is not equal to S
- **THEN** the trusted-surface decision outcome SHALL be `blocked`
- **AND** `candidate_sha` SHALL NOT be set to S or H as a guessed subject

#### Scenario: worktree HEAD still wins when present

- **WHEN** a managed worktree is on disk for the issue
- **AND** its HEAD is a full 40-character hex SHA
- **THEN** trusted-surface `candidate_sha` SHALL be that HEAD
- **AND** the engine SHALL NOT skip the worktree in favor of the PR head

### Requirement: Trusted-surface pin recency SHALL use persisted decision time

The engine SHALL order durable last-advanced trusted-surface pins by the timestamp persisted with each decision write, not by the originating run's `run_start` or run-id time. A durable resume that overwrites a trusted-surface decision under an older run ID SHALL assign that rewrite the new persist timestamp. When a stored trusted-surface decision has no persist timestamp, the engine MAY fall back to that run's `run_start` or run-id time.

#### Scenario: resumed older run ID updated after a later-started run

- **WHEN** issue N has no managed worktree on disk
- **AND** a later-started run recorded trusted-surface SHA H
- **AND** an older run ID is resumed and persists a different trusted-surface SHA P at a later decision time
- **AND** the linked open PR head equals H
- **THEN** the last-advanced candidate pin SHALL be P
- **AND** the trusted-surface decision outcome SHALL be `blocked`
- **AND** `candidate_sha` SHALL NOT be set to H

### Requirement: Absent-worktree candidate SHA regressions SHALL fail the unit suite

Automated tests covered by `npm run ci` SHALL inject I/O (no live network, git, or subprocess) and SHALL fail if: (1) a re-run at `pre-merge` with no on-disk managed worktree and a linked open PR whose head matches the last-advanced candidate still records trusted-surface `worktree_unavailable` or leaves the PR untagged at ready-to-deploy; (2) a PR head that is not the last-advanced candidate is accepted as the trusted-surface or readiness `candidate_sha`; (3) an older durable pin that matches the live PR head is accepted when a newer authoritative pin differs, including when that newer pin was written by resuming an older run ID after a later-started run.

#### Scenario: matching PR head still reporting worktree_unavailable fails the suite

- **WHEN** a unit test drives a `pre-merge` re-entry with no on-disk managed worktree
- **AND** a linked open PR head matches the last-advanced candidate
- **AND** other readiness gates pass
- **THEN** the test SHALL fail unless the trusted-surface decision uses that PR head as `candidate_sha` and does not report `worktree_unavailable`

#### Scenario: mismatched PR head accepted as candidate fails the suite

- **WHEN** a unit test drives the same re-entry with no on-disk managed worktree
- **AND** the linked open PR head differs from the last-advanced candidate pin
- **THEN** the test SHALL fail unless the decision is `blocked` with a named mismatch or unresolved outcome
- **AND** SHALL fail if that PR head is stored as trusted-surface or readiness `candidate_sha`

#### Scenario: older matching SHA accepted while a newer pin differs fails the suite

- **WHEN** a unit test drives a `pre-merge` re-entry with no on-disk managed worktree
- **AND** more than one prior durable last-advanced record exists
- **AND** an older record's SHA equals the linked open PR head
- **AND** a newer record's SHA differs
- **THEN** the test SHALL fail unless the decision is `blocked` with a named mismatch or unresolved outcome
- **AND** SHALL fail if that older PR head is stored as trusted-surface or readiness `candidate_sha`

#### Scenario: resumed older run ID whose decision time is newer fails the suite if the later-started SHA is accepted

- **WHEN** a unit test drives a `pre-merge` re-entry with no on-disk managed worktree
- **AND** a later-started run recorded trusted-surface SHA H that equals the linked open PR head
- **AND** an older run ID has a trusted-surface SHA P persisted at a later decision time
- **THEN** the test SHALL fail unless the decision is `blocked` with a named mismatch or unresolved outcome
- **AND** SHALL fail if H is stored as trusted-surface or readiness `candidate_sha`
