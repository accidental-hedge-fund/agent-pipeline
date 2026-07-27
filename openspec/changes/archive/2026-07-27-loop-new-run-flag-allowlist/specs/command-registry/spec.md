## ADDED Requirements

### Requirement: The `loop` registry entry SHALL allow every `loop:`-namespaced registered option

The `loop` entry in `COMMAND_REGISTRY` SHALL declare, in its `allowedFlags` set, the Commander
attribute name of every option registered in `buildCmd()` whose help description is `loop:`-namespaced
(currently `--range`, `--roadmap-slice`, `--resume`, `--audit`, and `--new-run`). In particular
`allowedFlags` SHALL contain `"newRun"`, so `pipeline loop --new-run <selector>` passes unified flag
validation and reaches the loop command handler. Adding this attribute name SHALL NOT change
`--new-run` semantics, and SHALL NOT alter any other command entry's `allowedFlags`.

#### Scenario: `--new-run` is accepted by loop flag validation

- **WHEN** `validateFlags` is called with the `loop` registry entry and a command in which the
  `newRun` option was explicitly provided on the command line
- **THEN** it SHALL return an empty array of offending flags
- **AND** the CLI SHALL NOT exit with code 2 for `pipeline loop --new-run <selector>`
- **AND** the loop command handler SHALL be reached with `newRun` set to `true`

#### Scenario: Every `loop:`-namespaced option is in the loop allowlist

- **WHEN** the options registered in `buildCmd()` are enumerated and filtered to those whose help
  description begins with `loop:`
- **THEN** every such option's Commander attribute name SHALL be present in
  `COMMAND_REGISTRY.loop.allowedFlags`

#### Scenario: Other command allowlists are unaffected

- **WHEN** the registry is inspected after this change
- **THEN** no command entry other than `loop` SHALL have gained or lost an `allowedFlags` member
- **AND** `newRun` SHALL NOT be added to `UNIVERSAL_FLAGS`

### Requirement: The registry/CLI allowlist cross-check SHALL be bidirectional for the loop command

The command-registry test suite SHALL guard allowlist/CLI drift in both directions for the `loop`
command: every attribute name in `COMMAND_REGISTRY.loop.allowedFlags` SHALL correspond to an option
registered in `buildCmd()` (the existing direction), **and** every `loop:`-namespaced registered
option SHALL appear in `COMMAND_REGISTRY.loop.allowedFlags` (the previously unguarded direction).
The reverse-direction guard SHALL fail against a registry in which a registered `loop:` option is
missing from the loop allowlist.

#### Scenario: A registered loop option missing from the allowlist fails the guard

- **WHEN** a `loop:`-namespaced option is registered in `buildCmd()` but its attribute name is absent
  from `COMMAND_REGISTRY.loop.allowedFlags`
- **THEN** the command-registry test suite SHALL fail, naming the missing attribute name

#### Scenario: An allowlisted name with no registered option still fails the guard

- **WHEN** `COMMAND_REGISTRY.loop.allowedFlags` contains an attribute name that no option registered
  in `buildCmd()` produces
- **THEN** the existing cross-check SHALL continue to fail, so the new guard does not weaken the
  original direction
