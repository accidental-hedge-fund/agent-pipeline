## ADDED Requirements

### Requirement: Evidence bundle MAY contain an auto_merge_eligibility artifact record
When the auto-merge eligibility gate runs and produces a verdict, the evidence bundle SHALL record the result as an `auto_merge_eligibility` field on the accumulated stage data, written via the existing record API before `finalizeRun()` writes `summary.json`. The field SHALL be absent (not `null`) when the gate is disabled.

The `auto_merge_eligibility` artifact record SHALL conform to the `AutoMergeEligibilityArtifact` schema defined in `auto-merge-eligibility-schema.ts`. Its required fields are: `eligibility`, `evaluated_at`, `deterministic_checks`, `denial_reasons`, `judge_output`, `ci_status_snapshot`, `review_verdict_snapshot`, `linked_run_id`, `linked_issue`, `linked_pr`, and `revert_note` (see the `auto-merge-eligibility` capability spec for the full field definitions).

#### Scenario: artifact present in summary.json when gate ran
- **WHEN** `auto_merge_eligibility.enabled: true` and the gate completes successfully
- **THEN** `summary.json` SHALL contain an `auto_merge_eligibility` field with all required subfields

#### Scenario: artifact absent when gate is disabled
- **WHEN** `auto_merge_eligibility.enabled: false`
- **THEN** `summary.json` SHALL NOT contain an `auto_merge_eligibility` field

#### Scenario: artifact written before finalization
- **WHEN** the gate runs inside `shipcheck-gate`
- **THEN** the artifact SHALL be recorded before `finalizeRun()` is called
- **AND** SHALL appear in both `summary.json` and the legacy `evidence.json`
