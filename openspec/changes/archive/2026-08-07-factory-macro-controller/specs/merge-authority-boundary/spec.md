## ADDED Requirements

### Requirement: Factory macro-controller merge and release phases SHALL remain operator-gated

When the factory macro-controller enters a coarse phase that concerns merge or release preparation, it SHALL only derive operator-facing next actions and durable evidence of readiness posture. It SHALL NOT invoke unattended merge, SHALL NOT call `mergePr` or merge-queue apply from the macro-controller tick path, SHALL NOT finalize a release as an autonomous side effect of phase advancement, and SHALL NOT introduce an `auto_merge` configuration key. Explicit operator invocation surfaces (`pipeline merge`, `merge-queue --apply`, and operator release commands) remain the only merge/release mutation authorities, subject to existing session-bound operator rules and #662's separate evidence standard for any future unattended merge executor.

#### Scenario: Macro tick does not merge

- **WHEN** a factory run's coarse phase is merge preparation and a tick runs
- **THEN** the tick MAY record that operator merge is the next action and refresh readiness evidence
- **AND** the tick SHALL NOT squash-merge a PR or apply the merge queue

#### Scenario: Macro tick does not finalize release unattended

- **WHEN** a factory run's coarse phase is release preparation and a tick runs
- **THEN** the tick MAY record operator release preparation as the next action
- **AND** the tick SHALL NOT perform release finalization that the ordinary operator release surface reserves for explicit invocation

#### Scenario: No auto_merge key via factory config

- **WHEN** factory macro-controller configuration surfaces are inspected
- **THEN** they SHALL NOT introduce an `auto_merge` key that enables unattended merge
