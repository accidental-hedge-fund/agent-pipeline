## ADDED Requirements

### Requirement: Evidence bundle SHALL record the trusted-surface decision and effective verifier identity

When a run computes a trusted-surface decision, the finalized evidence bundle (`summary.json` and the legacy `evidence.json` mirror) SHALL include a structured `trusted_surface` record (or equivalent documented key) carrying at least: `schema_version`, `outcome` (`passthrough` | `rebound` | `blocked`), `path_class_schema_version`, `candidate_sha`, `base_sha` when known, `triggering_paths`, `effective_verifier_hash` when resolved, per-class trusted source and content hash summaries, and `reason`. The record SHALL be written by deterministic engine code from the decision object — not from harness prose. An external consumer (including Project Warrant) SHALL be able to read which verifier surface judged the run without recomputing path classification or content hashes from source trees when the record is present. When no decision was computed (historical runs), the field MAY be absent; consumers MUST NOT invent a `passthrough` outcome for missing records.

#### Scenario: rebound decision appears in summary

- **WHEN** a run finalizes with trusted-surface `outcome` `rebound` and effective verifier hash H
- **THEN** `summary.json` SHALL include a `trusted_surface` object with `outcome` `rebound`
- **AND** `effective_verifier_hash` SHALL equal H
- **AND** `triggering_paths` SHALL be non-empty

#### Scenario: passthrough decision is explicit

- **WHEN** a run finalizes with trusted-surface `outcome` `passthrough`
- **THEN** `summary.json` SHALL record `outcome` `passthrough`
- **AND** `triggering_paths` SHALL be empty

#### Scenario: missing historical record is not synthesized as passthrough by the bundle writer

- **WHEN** a historical finalized bundle predates trusted-surface recording
- **THEN** the bundle MAY omit `trusted_surface`
- **AND** a later reader SHALL NOT treat omission as an implicit successful `passthrough` claim without an explicit legacy rule

#### Scenario: blocked decision is visible for dossier consumers

- **WHEN** a run ends with trusted-surface `outcome` `blocked`
- **THEN** the finalized bundle SHALL include `outcome` `blocked` and a non-empty reason
- **AND** Project Warrant or other consumers SHALL be able to refuse readiness claims by reading that field without recomputing the decision
