## ADDED Requirements

### Requirement: Override-bearing blocker recipes SHALL mark override as the human decision path

Every `BLOCKER_RECIPES` entry that includes an override command (`--override` or `pipeline override`) SHALL state that the command is for the human decision path: an operator MUST supply or explicitly approve the exact finding key and reason. The recipe SHALL state that the printed command is not authority for an autonomous host to invent or execute that disposition. Recipes MAY still show the executable override example so a human can copy it. The `needs-human` and `human-decision-required` recipes SHALL name `pipeline recover-parked` as the recovery-first action when a residual park may still be unspent, and SHALL tell a remaining park to stop for human disposition rather than host-inferred override.

Existing kind-specific recovery content (fix findings, re-run, CI recovery, capacity wait) SHALL remain. Recipe snapshot or string-assertion tests SHALL fail if an override-bearing recipe again presents override as the autonomous next action or drops the operator-path qualifier.

#### Scenario: needs-human recipe is operator-path not host authority

- **WHEN** `setBlocked` is called with kind `needs-human`
- **THEN** the “### How to unblock” section MAY include an override command example
- **AND** that section SHALL state that the exact disposition is operator-supplied or explicitly approved
- **AND** it SHALL NOT present override as something an autonomous host should execute from its own judgment

#### Scenario: human-decision-required recipe is operator-path not host authority

- **WHEN** `setBlocked` is called with kind `human-decision-required`
- **THEN** the rendered recipe SHALL label any override command as the human decision path
- **AND** SHALL NOT treat host factual judgment as authorization to run it

#### Scenario: recovery-first appears on residual-park recipes

- **WHEN** the `needs-human` recipe is rendered for issue N
- **THEN** it SHALL name `pipeline recover-parked N` (or `$pipeline recover-parked {{N}}` before substitution) as the recovery-first action
- **AND** it SHALL state that a remaining park requires human disposition rather than a host-invented override

#### Scenario: snapshot fails if operator qualifier is dropped

- **WHEN** an override-bearing `BLOCKER_RECIPES` entry is edited to restore autonomous-override wording without an operator-path qualifier
- **THEN** the recipe snapshot or string-assertion test SHALL fail
- **AND** the failure SHALL identify the kind whose recipe changed
