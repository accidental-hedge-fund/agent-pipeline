## ADDED Requirements

### Requirement: Schedule next_actions SHALL NOT advertise advance for GitHub-blocked items without an unblock path

The durable loop schedule SHALL NOT present an actionable `advance` disposition in `next_actions`
for an item whose live labels include `pipeline:blocked` (including when a stage label co-presents)
when no unblock path has cleared that blocker. The action SHALL be a hold / waiting /
unblock-oriented disposition consistent with the per-item needs-human hold model, until a human
clears `pipeline:blocked` or an audited unblock path applies. This requirement is additive
disclosure and schedule hygiene: it SHALL NOT weaken run-fatal classification for genuine engine
defects, and SHALL NOT clear or rewrite GitHub labels on its own.

#### Scenario: Blocked pre-merge item is not next_actions advance

- **WHEN** live labels for an item include `pipeline:blocked` after a pre-merge needs-human
  escalation
- **AND** no unblock path has cleared that label
- **THEN** reconciliation `next_actions` for that item SHALL NOT be an actionable `advance`
- **AND** the disposition SHALL indicate the item is held awaiting human unblock (or equivalent
  non-dispatchable state)

#### Scenario: Cleared blocker can become advanceable again

- **WHEN** a previously blocked item no longer carries `pipeline:blocked` on live truth and is
  otherwise schedulable
- **THEN** reconciliation MAY assign an `advance` (or other progressive) next action under the
  existing scheduler rules

#### Scenario: Engine defects remain run-fatal when applicable

- **WHEN** a dispatch is rejected or crashes without a `pipeline:blocked` disposition
- **THEN** existing `workflow-engine-defect` / `run_fatal` policy SHALL apply unchanged
