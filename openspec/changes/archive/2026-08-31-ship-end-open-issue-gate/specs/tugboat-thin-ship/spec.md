## ADDED Requirements

### Requirement: Tugboat post-train phases SHALL fail closed while any issue on the ship milestone remains open

After train is complete or resumed complete, Tugboat SHALL run the same remaining-open check as in-engine `pipeline ship` immediately before it starts or resumes `factory-release prepare`, Factory Reliability Gate (FRG) pack, FRG convergence, release, or `engine-promote`. Tugboat SHALL NOT keep a second, skippable remaining-open policy. Pipeline labels SHALL NOT exempt an open milestoned issue. Unmilestoned engine-filed factory-gate pack issues SHALL NOT count. A persisted earlier pass SHALL NOT authorize a later Tugboat post-train phase.

WHEN at least one GitHub issue on the ship milestone remains open, or when live observation cannot prove zero remaining open issues, Tugboat SHALL fail closed before those operations. The fail-closed message SHALL name the milestone and every remaining open issue number. Tugboat SHALL NOT start FRG pack, release, or `engine-promote` in that state. `--skip-frg` SHALL NOT be a way to start those operations while the milestone still has open issues.

#### Scenario: Leftover open backlog after Tugboat train blocks FRG pack

- **WHEN** Tugboat train for milestone `v1.40.1` has completed
- **AND** GitHub still has an open issue on that milestone
- **THEN** Tugboat SHALL fail closed before `factory-release prepare` and FRG pack
- **AND** it SHALL NOT invoke `pipeline release` or `engine-promote` for that version

#### Scenario: Tugboat does not keep a skippable local remaining-open policy

- **WHEN** an automated check inspects Tugboat's post-train path
- **THEN** that path SHALL invoke the same remaining-open check used by in-engine ship
- **AND** it SHALL NOT skip FRG, release, or promote because freeze-eligible items were integrated
