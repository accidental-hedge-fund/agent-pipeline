## ADDED Requirements

### Requirement: Ship-path consumers SHALL distinguish hybrid policy by identity, not pack_provenance presence

A ship-path consumer of already-validated release-eligible Factory Reliability Gate (FRG) evidence SHALL distinguish historical hybrid-v1 from durable hybrid-v2 by `pack_provenance.policy_id`. It SHALL NOT treat mere presence of `pack_provenance` as the historical `1.33.0` hybrid-v1 pin. It SHALL reuse the shared FRG validator for policy, manifest, fingerprint, proof-matrix, and HMAC checks. It SHALL reuse the existing unsigned-digest binding comparison for `factory_release_binding`. It SHALL NOT invent a second policy decoder, HMAC checker, manifest checker, fingerprint checker, proof-matrix checker, or binding schema.

After `1.33.0`, that consumer SHALL accept only `factory-gate-v1-hybrid-v2` whose HMAC-covered `factory_release_binding` fully matches the closed checkpoint. Hybrid-v1 SHALL remain valid only for exactly `1.33.0`. Presence of valid `pack_provenance` SHALL NOT reject HMAC-pass hybrid-v2. A later post-pilot ship with the same honest hybrid-v2 shape SHALL pass this consumer without a new mole issue.

This requirement does not authorize `--skip-frg`. It does not strip `pack_provenance` from honest `--from-run` evidence. It does not change leaf `pipeline release` or `release ensure-tag`, which already reuse the shared validator and do not apply the ship-specific candidate assertion.

#### Scenario: Policy identity, not presence, selects hybrid-v1 vs hybrid-v2

- **WHEN** a ship-path consumer receives HMAC-pass evidence whose `pack_provenance.policy_id` is `factory-gate-v1-hybrid-v2` for a version after `1.33.0`
- **THEN** it SHALL NOT reject the artifact solely because `pack_provenance` is present
- **AND** it SHALL NOT apply the `1.33.0`-only hybrid-v1 pin to that policy id

#### Scenario: Shared validator and binding comparison are reused

- **WHEN** that consumer decides whether post-pilot hybrid-v2 evidence is ship-acceptable
- **THEN** policy, manifest, fingerprint, proof-matrix, and HMAC SHALL be the shared validator's decision
- **AND** checkpoint equality SHALL be the existing unsigned-digest binding comparison
- **AND** the consumer SHALL NOT reimplement those checks

#### Scenario: Next post-pilot ship does not need a new mole

- **WHEN** a later release after `1.40.0` presents HMAC-pass hybrid-v2 evidence with matching train candidate and matching closed checkpoint
- **THEN** the same consumer SHALL accept that evidence
- **AND** a unit test SHALL fail if presence of `pack_provenance` on a non-`1.33.0` version is sufficient grounds to reject
