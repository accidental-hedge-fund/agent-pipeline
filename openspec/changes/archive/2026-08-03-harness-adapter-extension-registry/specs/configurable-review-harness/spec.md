## ADDED Requirements

### Requirement: Custom reviewer CLIs SHALL resolve through the adapter extension contract rather than a permanent raw-spawn bypass

`invoke()` and review routing SHALL treat an unregistered reviewer command as a compatibility
registration of the public adapter extension contract (see `adapter-extension-registry`), not as a
permanent special-case spawn that skips capability preflight, treatment identity, and normalized
failure classification. Existing `review_harness` string and object forms (including
`prompt_delivery`) SHALL keep their configured behavior. When the reviewer name matches a
registered full adapter, that adapter SHALL win over the compatibility path.

#### Scenario: review_harness string uses compatibility adapter path

- **WHEN** `review_harness: my-reviewer` is configured and `my-reviewer` is not a registered full
  adapter package
- **THEN** reviewer invocation SHALL still spawn `my-reviewer` with the configured prompt-delivery
  channel
- **AND** the invocation path SHALL use the extension-contract compatibility adapter rather than a
  harness-name branch that bypasses the adapter interface

#### Scenario: review_harness object retains model, effort, and prompt_delivery

- **WHEN** `review_harness: { command: my-reviewer, model: auto, effort: high, prompt_delivery: stdin }`
  is configured
- **THEN** resolution SHALL preserve command, model, effort, and stdin prompt delivery exactly as
  before the migration
- **AND** those settings SHALL be applied through the compatibility adapter's declared surface

#### Scenario: Registered full adapter wins over compatibility

- **WHEN** package registration supplies a full adapter for ID `my-reviewer`
- **AND** `review_harness: my-reviewer` is configured
- **THEN** invocation SHALL use the full registered adapter
- **AND** the thin compatibility adapter SHALL NOT override it

#### Scenario: Unspawnable custom reviewer still yields an actionable error

- **WHEN** the configured custom reviewer CLI is missing from `PATH`
- **THEN** the surfaced error SHALL name the CLI
- **AND** the failure classification SHALL be compatible with the public missing-CLI vocabulary
  used for registered adapters
