## ADDED Requirements

### Requirement: Readiness subject candidate_sha SHALL use the resolved later-stage pin when the worktree is absent

When a readiness-relevant producer emits `evidence_subject` for a run whose managed worktree is absent and whose stage is at or after `pre-merge`, the producer SHALL set `candidate_sha` to the SHA resolved by trusted-surface from the linked open PR head or the explicit candidate-SHA override. That SHA SHALL be a full 40-character hexadecimal value from engine runtime state (PR head, override seam, or last-advanced pin). The producer SHALL NOT invent a placeholder SHA, copy an all-zero trusted-surface sentinel, or take a SHA from harness prose.

When no matching SHA source exists, the producer SHALL fail closed for readiness subject production (missing or malformed subject) rather than emit a well-formed subject that claims a fabricated candidate. Consumers SHALL treat that subject as non-authoritative for a readiness pass.

#### Scenario: re-entry readiness subject binds the matching PR head

- **WHEN** issue N has no managed worktree on disk
- **AND** trusted-surface resolved `candidate_sha` to linked open PR head H
- **AND** a readiness producer emits `evidence_subject`
- **THEN** `evidence_subject.candidate_sha` SHALL equal H
- **AND** `evidence_subject.pr` SHALL be that pull request number

#### Scenario: missing SHA source fails closed for the readiness subject

- **WHEN** issue N has no managed worktree on disk
- **AND** no explicit override and no matching open PR head exist
- **THEN** the producer SHALL NOT emit a well-formed `evidence_subject` that claims a fabricated `candidate_sha`
- **AND** consumers SHALL treat any missing or malformed subject as non-authoritative for readiness pass

#### Scenario: mismatched PR head is not a readiness subject

- **WHEN** the linked open PR head differs from the last-advanced candidate pin
- **AND** no managed worktree is on disk
- **THEN** the producer SHALL NOT emit a well-formed `evidence_subject` whose `candidate_sha` is that PR head
