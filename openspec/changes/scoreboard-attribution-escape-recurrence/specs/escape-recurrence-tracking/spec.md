## ADDED Requirements

### Requirement: The engine SHALL define a seed defect-class key registry for escape-recurrence

The engine SHALL maintain a deterministic seed registry of defect-class keys used for
escape-recurrence metrics. The seed set SHALL include at least: `delta-sha-gate`,
`openspec-archive`, `salvage`, and `worktree` (exact strings locked by tests). Additional
keys MAY be added to the registry without removing seed keys. Occurrences observed in
run ledgers, auto-file signals, or control-attribution `correction_key` values SHALL map
into registry keys via a pure mapper; unmapped occurrences SHALL NOT enter the
escape-recurrence ratio denominator.

#### Scenario: Seed keys are present and stable

- **WHEN** the seed defect-class registry is inspected
- **THEN** it SHALL contain `delta-sha-gate`, `openspec-archive`, `salvage`, and `worktree`
- **AND** tests SHALL lock those exact strings

#### Scenario: Unmapped occurrence is excluded from recurrence denominator

- **WHEN** a ledger event carries a signal that the pure mapper does not map to any
  registry key
- **THEN** that occurrence SHALL NOT count as a fix-boundary class or a recurrence hit
  for escape-recurrence
- **AND** it MAY appear in a residual/unmapped diagnostic count

---

### Requirement: A fix-release boundary SHALL be required before a class enters the recurrence denominator

A defect-class key SHALL enter the escape-recurrence **denominator** only when a
fix-release boundary is known for that key. A fix-release boundary SHALL be established
from, in priority order: (1) a `control_attribution` (or equivalent durable attribution)
with non-null `effective_release` or effective tag for that class key; (2) a documented
release observation / FRG trend entry that records the class as fixed at a version; (3)
no other free-text inference. Classes without a fix boundary SHALL be reported in
missing-boundary diagnostics and SHALL NOT inflate the recurrence ratio.

#### Scenario: Class with effective_release enters denominator

- **WHEN** a control attribution records `correction_key` mapping to `salvage` with
  `effective_release: "v1.30.0"`
- **THEN** `salvage` SHALL be included in the escape-recurrence denominator for windows
  that evaluate post-fix recurrence against that boundary

#### Scenario: Class without boundary is diagnosed, not counted as non-recurrent success

- **WHEN** `worktree` occurrences exist but no fix-release boundary is known
- **THEN** `worktree` SHALL NOT be counted in the recurrence ratio denominator
- **AND** diagnostics SHALL include a stable missing-boundary code for that key

---

### Requirement: Escape-recurrence SHALL count post-boundary reappearance of a fixed class

A defect-class key with fix-release boundary B SHALL count as a **recurrence** when at
least one new occurrence of that key is observed with a timestamp or producing release
strictly after B. Occurrences at or before B SHALL NOT count as recurrence. The
escape-recurrence aggregate SHALL expose at minimum: `classes_with_fix_boundary`
(denominator), `classes_with_post_fix_occurrence` (numerator), and `ratio` as a
scoreboard `RateValue` (`ratio` is `null` when the denominator is zero). Per-key rows
SHALL be available in JSON output.

#### Scenario: Post-boundary occurrence is recurrence

- **WHEN** `delta-sha-gate` has fix boundary release `v1.29.0`
- **AND** a new mapped occurrence is observed after that release ships
- **THEN** `delta-sha-gate` SHALL count toward the recurrence numerator
- **AND** the per-key row SHALL mark it recurrent

#### Scenario: Pre-boundary occurrence is not recurrence

- **WHEN** `openspec-archive` has fix boundary `v1.28.0`
- **AND** the only occurrences are before that boundary
- **THEN** `openspec-archive` SHALL remain in the denominator
- **AND** it SHALL NOT count toward the recurrence numerator

#### Scenario: Zero fix boundaries yields null ratio

- **WHEN** no registry key has a known fix-release boundary in the evaluation inputs
- **THEN** escape-recurrence `ratio` SHALL be `null`
- **AND** numerator and denominator SHALL be `0`
