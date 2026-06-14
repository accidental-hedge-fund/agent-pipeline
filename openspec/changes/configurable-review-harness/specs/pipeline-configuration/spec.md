## MODIFIED Requirements

### Requirement: Harness roles come from the active profile, not file config
The `harnesses` (`implementer`/`reviewer`) SHALL be taken from the active profile (`profile.harnesses`). The `harnesses` key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error. The implementer harness SHALL NOT be overridable by file config. The reviewer harness MAY be overridden by the optional `review_harness` key (see `configurable-review-harness`); when `review_harness` is absent, the profile's reviewer is used unchanged.

#### Scenario: harnesses key rejected
- **WHEN** `.github/pipeline.yml` sets a `harnesses:` block
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `harnesses` as an unknown key

#### Scenario: reviewer overridden via review_harness
- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"my-reviewer"` and `cfg.harnesses.implementer` SHALL remain as the profile's default implementer

#### Scenario: implementer cannot be overridden by file config
- **WHEN** `.github/pipeline.yml` sets only `review_harness`
- **THEN** `cfg.harnesses.implementer` SHALL equal the profile's implementer, unchanged by any file config key
