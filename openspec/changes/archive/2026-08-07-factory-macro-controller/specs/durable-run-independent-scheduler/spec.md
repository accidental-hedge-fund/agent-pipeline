## ADDED Requirements

### Requirement: Factory macro-controller activation SHALL NOT alter independent-scheduler concurrency rules

Enabling or running the factory macro-controller SHALL NOT change the durable-run independent scheduler's serial default, concurrency budget interpretation, or proven-independence admission rules. The scheduler SHALL continue to treat serial execution as the default and SHALL admit more than one item into `in_progress` only when the **loop** contract carries an explicit concurrency policy with budget greater than one **and** independence proofs pass. The macro-controller SHALL NOT inject a higher budget, SHALL NOT mark items independent by factory fiat, and SHALL NOT start additional in-progress items outside the scheduler's selected set.

#### Scenario: Factory enablement leaves serial default intact

- **WHEN** a factory-linked loop contract carries no concurrency policy (or budget one)
- **THEN** the independent scheduler SHALL still select exactly one item
- **AND** factory macro-controller enablement alone SHALL NOT cause a second item to become `in_progress`

#### Scenario: Factory cannot bypass independence proof

- **WHEN** a loop contract has concurrency budget greater than one but an additional eligible item fails an independence check
- **THEN** the scheduler SHALL refuse to admit that item
- **AND** the macro-controller SHALL NOT force-start it as a separate whole-item child to evade the check
