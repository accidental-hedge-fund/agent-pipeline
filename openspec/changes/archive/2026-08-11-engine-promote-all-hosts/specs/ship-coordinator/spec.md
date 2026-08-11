## ADDED Requirements

### Requirement: Ship coordinator promote phase SHALL install to all hosts by default

When the in-engine ship coordinator (`pipeline ship`) reaches the engine-promote phase and the operator has not scoped the install host, the coordinator SHALL promote and install using effective host selector `all` so every installer-managed outer-host skill tree receives the released engine. The coordinator SHALL NOT leave Claude, Grok, or OpenCode on a prior release solely because the promote call omitted a host option and inherited a codex-only default.

#### Scenario: Authorized ship promote uses multi-host install default

- **WHEN** an authorized `pipeline ship` completes publication and runs engine promote for version `X.Y.Z`
- **AND** the operator has not scoped promote to a single host
- **THEN** the composed engine-promote install SHALL use host selector `all`
- **AND** the install command or promote result recorded for that phase SHALL include `--host all` (or an equivalent explicit multi-host selector)

#### Scenario: Ship promote does not silent-default to codex only

- **WHEN** the ship coordinator promote path invokes engine-promote without an operator host override
- **THEN** the effective install host SHALL NOT be `codex` alone as an implicit omitted-host default
