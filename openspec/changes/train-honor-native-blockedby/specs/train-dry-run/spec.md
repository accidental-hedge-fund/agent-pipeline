## ADDED Requirements

### Requirement: Train dry-run SHALL use the same shared discovery graph as live train

Dry-run SHALL resolve declared dependencies through the same shared discovery contract
live train uses (lexical, GitHub-native `blockedBy`, and enabled roadmap-declared edges,
after hard-wait admission). Dry-run SHALL classify frontier membership and intended
actions from that graph. A native or mixed-source admitted prerequisite that is not yet
integrated SHALL classify the dependent as `waiting-on-deps` (or not frontier-eligible)
the same way a live train would exclude it from the current frontier. Dry-run SHALL NOT
parse title and body as the sole declared-dependency source.

A fresh multi-item dry-run SHALL refuse with a typed, actionable incomplete-discovery
result when any enabled authoritative source is `unavailable` or `incomplete`. It SHALL
NOT print a successful plan, SHALL NOT create a train run store, and SHALL exit non-zero.
Fully observed empty sources SHALL still produce a plan of independent items rather than
inventing edges.

#### Scenario: Native blockedBy makes the dependent waiting-on-deps

- **WHEN** `pipeline train --issues 1322,1323 --dry-run` fully observes that 1323 is
  natively blocked by 1322
- **AND** 1322 is not already integrated
- **AND** 1323 has no lexical `Depends on` phrase naming 1322
- **THEN** the plan SHALL list 1323 as `waiting-on-deps` or not frontier-eligible
- **AND** it SHALL NOT list 1323 as `would-advance` solely because the body lacked a
  lexical edge

#### Scenario: Dry-run and live train agree on native independence

- **WHEN** the same selected set and the same injected discovery observations are given to
  dry-run and to a live train
- **THEN** both SHALL produce the same ordered issues
- **AND** both SHALL classify the same items as waiting on admitted dependents versus
  independent / frontier-eligible

#### Scenario: Incomplete native source fails dry-run before a plan

- **WHEN** a fresh multi-item dry-run enables native `blockedBy` discovery
- **AND** that source is `unavailable` or `incomplete` for a selected issue
- **THEN** the command SHALL exit non-zero with a typed result naming that source
- **AND** it SHALL NOT print a successful `train_plan`
- **AND** it SHALL NOT create a train run store
