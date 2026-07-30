## ADDED Requirements

### Requirement: Loop orchestration docs SHALL treat pre-merge gate progress as material loop events

Host skill guidance for `pipeline:loop` drive and resume SHALL list the shared
loop progress event kind used for pre-merge gate sub-steps (default name
`loop_item_progress`, or the single shared progress kind name if renamed to
converge with stage progress) among material loop events that warrant a harness
notification or Push when `domain` is `pre_merge` and `status` is a definitive
outcome (`pass`, `fail`, `approve`, `needs_attention`, `attempted`, `success`,
`exhausted`, `blocked`, `advanced`) or the first `waiting` for a CI stretch.
The guidance SHALL state that these events appear on the **loop** event stream
while advance linkage is active so hosts are not forced to parse advance-only
logs for major gate outcomes.

#### Scenario: Material list includes progress kind

- **WHEN** an operator reads the material-events list in host skill guidance
- **THEN** the list SHALL include the shared progress event kind
  (`loop_item_progress` or the converged shared name)

#### Scenario: Docs state loop stream carries pre-merge gate outcomes

- **WHEN** an operator reads loop orchestration guidance for mid-item progress
- **THEN** the text SHALL state that material pre-merge gate outcomes (CI,
  OpenSpec archive, delta review, auto-fix, terminal blocked/advanced) are
  published on the loop event stream while the item is advance-linked

---

### Requirement: Loop orchestration docs SHALL keep optional advance follow for full fidelity

Host skill guidance SHALL continue to document that following the linked
advance `events.jsonl` path (from `loop_item_advance_linked`) remains available
for full-fidelity stage and harness detail. After pre-merge gate progress is
mirrored onto the loop stream, advance follow SHALL be documented as optional
for gate outcomes (not required solely to learn CI/delta/auto-fix results),
while remaining useful for deeper diagnostics.

#### Scenario: Optional advance follow remains documented

- **WHEN** an operator reads the loop orchestration section
- **THEN** the text SHALL still describe how to obtain the advance `events`
  path from linkage and optionally follow it
- **AND** SHALL NOT claim that advance follow is the only way to observe
  material pre-merge gate outcomes once loop progress mirroring is present
