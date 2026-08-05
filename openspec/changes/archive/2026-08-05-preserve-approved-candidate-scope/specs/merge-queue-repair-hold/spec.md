## ADDED Requirements

### Requirement: Merge-queue restack and repair SHALL apply candidate-integrity before re-gate eligibility

The merge-queue path SHALL run the candidate-integrity protocol (pre-manifest, post-manifest, classification, durable event) with the appropriate `mutation_method` (`restack`, `rebase`, `conflict_repair`, or `recovery_repair` as applicable) when merge-queue restack, deterministic rebase, or optional surgical/mechanical repair moves a candidate head. A classification of `scope_expansion` or `unverified` SHALL make the item not re-gate eligible for merge on that head: the queue SHALL fail closed or retain a typed hold with operator-visible diagnostics that name the integrity classification, and SHALL NOT call `mergePr` as a successful repair outcome for that head. A `semantically_equivalent` restack MAY proceed to re-gate only after current-head gates re-evaluate. This requirement generalizes surface integrity beyond the existing README landing-page-specific fail-closed rule and MUST NOT introduce unattended merge or weaken merge-authority boundaries.

#### Scenario: Scope expansion after restack is not merge-eligible

- **WHEN** merge-queue restack or repair classifies as `scope_expansion`
- **THEN** re-gate SHALL NOT report the item as eligible to merge on that head
- **AND** the queue SHALL NOT call `mergePr` for that head as a successful repair outcome
- **AND** hold or diagnostic evidence SHALL name the candidate-integrity classification

#### Scenario: Clean restack re-gates after current-head checks

- **WHEN** restack classifies as `semantically_equivalent`
- **AND** current-head eligibility gates (including CI/review/docs invariants as already required) pass
- **THEN** candidate-integrity SHALL NOT by itself hold the item
- **AND** merge remains subject to existing `mergePr` and human-authority rules

#### Scenario: Integrity failure is not a merge-authority grant

- **WHEN** classification is `unverified` after an optional repair attempt
- **THEN** the queue SHALL NOT force-merge
- **AND** SHALL NOT treat the integrity failure as authorization to skip re-gate or human merge authority
