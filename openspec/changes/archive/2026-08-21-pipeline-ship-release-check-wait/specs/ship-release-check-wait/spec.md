## ADDED Requirements

### Requirement: In-engine pipeline ship SHALL adopt the shared waiter

The shared ship-release check waiter SHALL be applied by in-engine `pipeline ship` before `pipeline release finish`. Tugboat MAY keep calling the same classifier. Tugboat SHALL NOT remain the only implementation. The in-engine waiter SHALL use the same four outcomes (`green` / `pending` / `rerun` / `fail`) and the same `gh pr checks --json` field set (`name`, `state`, `bucket`, `link`). It SHALL NOT request a `conclusion` field. A path-local Tugboat-only helper SHALL NOT satisfy this requirement.

#### Scenario: In-engine ship is an adoption site

- **WHEN** in-engine `pipeline ship` waits on an open release PR before finish
- **THEN** it SHALL classify the checks capture through the shared `ship-release-check-wait` outcomes
- **AND** it SHALL NOT one-shot `release finish` on a pending snapshot

#### Scenario: Tugboat-only helper is not enough

- **WHEN** an automated check inspects ship-path waiters
- **THEN** in-engine `pipeline ship` SHALL implement the shared waiter
- **AND** the check SHALL fail if only Tugboat or the chain playbook applies the recipe

#### Scenario: In-engine field set still rejects conclusion

- **WHEN** in-engine `pipeline ship` requests `gh pr checks --json` for the release PR
- **THEN** the field set SHALL include `name`, `state`, `bucket`, and `link`
- **AND** it SHALL NOT include `conclusion`
