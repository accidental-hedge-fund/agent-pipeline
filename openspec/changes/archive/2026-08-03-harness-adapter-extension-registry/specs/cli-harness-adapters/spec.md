## ADDED Requirements

### Requirement: Built-in adapters SHALL register through the same public extension contract as third-party adapters

The built-in local-CLI adapters (`claude`, `codex`, `grok`, `opencode`, `pi`) SHALL be registered
into the runtime registry through the public extension registration API (or equivalent public
registration path), not through a private side channel that bypasses the public contract. Their
invocation construction, preflight, telemetry parsing, and treatment description SHALL continue to
satisfy the existing `HarnessAdapter` behavioral requirements, including golden-argv regression
coverage for established claude and codex shapes. Adding a built-in SHALL not reintroduce a closed
compile-time name union as the production source of truth for "which adapters exist."

#### Scenario: Built-ins appear in the runtime registry via public registration

- **WHEN** the engine finishes built-in registration at boot
- **THEN** `claude`, `codex`, `grok`, `opencode`, and `pi` SHALL each resolve from the runtime
  registry
- **AND** each SHALL implement the public extension contract members required of every registered
  adapter

#### Scenario: Built-in invocation shapes do not intentionally regress

- **WHEN** golden-argv (or equivalent) regression tests run for built-in adapters after migration
  onto the public registration path
- **THEN** established invocation shapes for those adapters SHALL remain satisfied
- **AND** any intentional shape change SHALL be out of scope for this extension-registry change

#### Scenario: Production paths do not hardcode the built-in name set as completeness

- **WHEN** config error messages, doctor enumeration, discovery, help, or evals list available
  local-CLI adapters
- **THEN** the list SHALL come from the runtime registry
- **AND** a newly registered extension adapter SHALL appear without editing a hardcoded built-in
  name array in those consumers

---

### Requirement: Adapter identity namespace SHALL stay shared with extension golden-fixture and treatment surfaces

The adapter ID space used by the runtime registry SHALL be the same identity namespace referenced by
stage-output golden-fixture registration and by treatment/accounting adapter fields. Extension
adapters SHALL NOT require a second adapter namespace for fixtures or evidence. Production
validation of stage product output SHALL continue to avoid branching on adapter or provider name.

#### Scenario: Extension adapter ID is consistent across registry and fixtures

- **WHEN** an extension adapter registers under ID `ext-demo` and contributes a golden stage-output
  fixture
- **THEN** the fixture's adapter identity field SHALL use `ext-demo`
- **AND** treatment records for invocations of that adapter SHALL use the same ID

#### Scenario: Product-output validation remains adapter-name agnostic

- **WHEN** the central stage-output validator accepts or rejects product shape after adapter
  envelope normalization
- **THEN** acceptance SHALL NOT depend on reading the active adapter name as a provider branch
