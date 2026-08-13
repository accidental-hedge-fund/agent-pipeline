## ADDED Requirements

### Requirement: Ship-path autonomy preamble SHALL coexist with surgical-fix discipline

When fix-round prompts include the ship-path autonomy doctrine preamble (versioned marker and factory-class guidance), the surgical-fix requirements already defined by this capability SHALL remain fully in force for ordinary product review findings. The autonomy preamble SHALL NOT remove, bury, or weaken: (1) minimal finding-scoped diff instructions, (2) destructive-operation safety scope, or (3) pre-commit severity self-check. Class-over-site guidance in the preamble applies when the work is engine recovery, pipeline self-host, or ship-path dogfood autonomy; it is an additional judgment layer, not a license to refactor or broaden ordinary product fixes.

#### Scenario: Autonomy-injected fix prompt still forbids over-reach on ordinary findings

- **WHEN** `buildFixPrompt` is called and the built prompt includes the ship-path autonomy version marker
- **THEN** the returned prompt string SHALL still instruct the harness to make the minimal diff that resolves the finding
- **AND** it SHALL still explicitly forbid refactors, scope-broadening, unrelated changes, and opportunistic cleanup for ordinary product review findings

#### Scenario: Autonomy-injected fix prompt still guards destructive operations

- **WHEN** `buildFixPrompt` is called and the built prompt includes the ship-path autonomy version marker
- **THEN** the returned prompt string SHALL still name at least one guarded destructive operation and require managed-root / reviewed-head scoping or explicit justification as already required by this capability

#### Scenario: Drift tests still bite if surgical instructions disappear under autonomy injection

- **WHEN** any of the three surgical instructions is removed from the fix prompt while the autonomy preamble remains
- **THEN** at least one `buildFixPrompt` drift assertion SHALL fail
