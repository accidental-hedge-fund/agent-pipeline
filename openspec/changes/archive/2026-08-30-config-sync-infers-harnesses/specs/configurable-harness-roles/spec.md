## MODIFIED Requirements

### Requirement: The config schema SHALL accept a strict `harnesses` role block

`.github/pipeline.yml` SHALL accept a strict `harnesses` block with exactly two keys, `implementer` and `reviewer`, each a non-empty string naming a harness. The block SHALL be strict: any other key inside it SHALL be rejected at validation time with a message naming the offending key. For execution-policy resolution, omitting the block or omitting either key SHALL fail closed as specified by `required-repository-harness-roles`.

The block SHALL appear in the generated config JSON Schema with a description for each key that identifies the key as required repository execution policy. `pipeline config sync` SHALL preserve an existing complete `harnesses` block's effective values. Sync SHALL NOT comment either required role out, SHALL NOT document profile fallback for live workers, and SHALL NOT invent a missing live role from the active profile. Sync MAY infer an omitted role from explicit `models:` / `review_harness` evidence as specified by `config-sync-harness-inference`.

#### Scenario: Both roles declared

- **WHEN** `.github/pipeline.yml` contains `harnesses:` with `implementer: grok` and `reviewer: codex`
- **THEN** validation SHALL succeed
- **AND** `resolveConfig()` SHALL NOT throw

#### Scenario: Unknown key inside the block is rejected

- **WHEN** `.github/pipeline.yml` contains a `harnesses:` block with a key that is neither `implementer` nor `reviewer`
- **THEN** validation SHALL fail with a message naming the offending key
- **AND** no stage SHALL run

#### Scenario: Block absent

- **WHEN** `.github/pipeline.yml` contains no `harnesses:` block
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.implementer` and `harnesses.reviewer`

#### Scenario: Schema and sync expose the block

- **WHEN** `pipeline config schema` runs
- **THEN** its output SHALL describe the `harnesses` block with a description for `implementer` and for `reviewer`
- **AND** those descriptions SHALL NOT state that an omitted role falls back to the active profile
- **AND** `pipeline config sync` on a config already containing both roles SHALL preserve that config's effective behavior

#### Scenario: Sync does not fill a missing role from the profile

- **WHEN** `.github/pipeline.yml` omits `harnesses.reviewer` and has no classified reviewer model evidence
- **AND** the active profile reviewer is `codex`
- **AND** `pipeline config sync --apply` runs
- **THEN** the file SHALL remain unchanged
- **AND** the written candidate SHALL NOT contain a profile-filled `reviewer`
