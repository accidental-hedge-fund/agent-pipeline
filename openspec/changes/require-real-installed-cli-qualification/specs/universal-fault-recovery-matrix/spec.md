## ADDED Requirements

### Requirement: Installed-CLI matrix credit SHALL require launcher-produced qualification evidence

Installed-CLI rows SHALL be credited only from a validated candidate-bound qualification artifact produced by spawning the staged installed launcher. Static inventory declarations SHALL remain useful for completeness and expected-outcome binding but SHALL NOT be converted into executed rows. Source module paths, test-name substrings, generated titles, direct command-registry lookup, and direct simulator calls SHALL NOT establish execution.

#### Scenario: Complete inventory without execution receives no credit

- **WHEN** the matrix inventory is structurally complete but no valid installed-launcher qualification artifact exists for candidate `C`
- **THEN** installed-CLI lifecycle coverage for `C` SHALL be missing
- **AND** in-flight ship scoring SHALL NOT manufacture executed rows from the inventory

#### Scenario: Qualification rows remain inventory-bound

- **WHEN** a valid qualification artifact emits an installed-CLI row
- **THEN** the row SHALL still match one declared applicable matrix cell and expected typed terminal
- **AND** an undeclared or mismatched row SHALL receive no coverage
