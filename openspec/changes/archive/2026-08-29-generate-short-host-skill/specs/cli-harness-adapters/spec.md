## MODIFIED Requirements

### Requirement: Adapter setup and per-stage assignment SHALL be documented for every built-in adapter

Durable operator documentation SHALL describe, for each built-in adapter, the
operator-run login step required before use and an example configuration that
assigns the adapter to a model-invoking stage. The documentation SHALL state
that similarly named effort levels are not comparable across harnesses. A
generated short host one-pager MAY point to that documentation; it SHALL NOT be
required to carry the five-adapter setup and configuration tutorial.

#### Scenario: Documentation covers all five adapters

- **WHEN** the adapter setup documentation is read
- **THEN** it SHALL give a setup step and an example per-stage assignment for
  `claude`, `codex`, `grok`, `pi`, and `opencode`
- **AND** it SHALL state that effort levels are not comparable across harnesses

#### Scenario: Generated one-pager links instead of duplicating setup

- **WHEN** an operator reads a generated host one-pager
- **THEN** it MAY link to the durable adapter documentation
- **AND** it SHALL NOT be required to repeat login commands or per-stage YAML for
  all built-in adapters
