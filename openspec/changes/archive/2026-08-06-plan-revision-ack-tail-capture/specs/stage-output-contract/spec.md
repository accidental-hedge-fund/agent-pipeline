## ADDED Requirements

### Requirement: Freeform markdown stage-output contracts SHALL validate complete product text after envelope normalization

Registered freeform and markdown-section stage-output contracts (including `plan-revision.ack@1`) SHALL validate the **product** harness output after adapter envelope normalization — meaning the complete plain assistant text intended for stage consumers — and SHALL NOT validate a raw telemetry envelope fragment that is incomplete solely because machine-readable capture used tail bounding for cost recovery.

Envelope normalization for streaming machine-readable adapters SHALL therefore yield product text that includes leading streamed content required by those contracts when that content was present in the live assistant stream. A pure shape failure reported by a freeform contract MUST mean the product text lacked the required shape, not that the telemetry capture window discarded it.

#### Scenario: plan-revision.ack@1 sees complete product text

- **WHEN** central validation runs `plan-revision.ack@1` after a successful plan-revision harness exit
- **THEN** the `stdout` (or equivalent product field) passed into the contract’s pure `validate` function SHALL be the complete reconstructed product text for that invocation
- **AND** SHALL NOT be a telemetry-tail-only reconstruction that omitted a leading acknowledgement present in the live stream

#### Scenario: Pure shape failure remains product-true

- **WHEN** a freeform contract validate returns not-ok after normalisation
- **THEN** that not-ok result SHALL reflect absence or malformation in the complete product text
- **AND** the shared format-repair policy MAY re-prompt for true product shape failures
- **AND** the pipeline SHALL NOT classify a capture/reconstruction head-loss of an otherwise valid streamed section as a model shape failure for that same product text
