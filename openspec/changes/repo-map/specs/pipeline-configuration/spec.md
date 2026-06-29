## ADDED Requirements

### Requirement: Config SHALL accept an optional strict `repo_map` block

`PartialConfigSchema` SHALL accept an optional `repo_map` block with strict validation. Its
fields SHALL be `depends_on` (array of `owner/repo` strings, repos this repo consumes) and
`depended_on_by` (array of `owner/repo` strings, repos that consume this repo). Both lists
SHALL be optional and SHALL default to empty arrays in the resolved config. Each entry SHALL
match the `owner/repo` shape (exactly one `/`, with non-empty owner and name segments); an
entry that is not `owner/repo`-shaped SHALL cause `resolveConfig()` to throw a parse error
identifying the offending entry. An unknown sub-key under `repo_map` SHALL be rejected by
strict-schema validation, consistent with the other feature blocks. When the block is absent,
`repo_map` SHALL resolve to its `DEFAULT_CONFIG` value (both lists empty) and behavior SHALL
be unchanged.

The `repo_map` block is declarative context only. It SHALL NOT enable any cross-repo write,
merge, PR creation, label propagation, or status sync; it SHALL NOT weaken the never-auto-merge
safety floor. Relationships are declared independently per repo — the pipeline SHALL NOT infer
a reverse edge in another repo from a local declaration.

#### Scenario: valid repo_map block resolves

- **WHEN** `.github/pipeline.yml` sets:
  ```yaml
  repo_map:
    depends_on:
      - acme/shared-lib
    depended_on_by:
      - acme/consumer-app
  ```
- **THEN** `resolveConfig()` SHALL succeed
- **AND** `config.repo_map.depends_on` SHALL equal `["acme/shared-lib"]`
- **AND** `config.repo_map.depended_on_by` SHALL equal `["acme/consumer-app"]`

#### Scenario: repo_map absent — defaults to empty lists

- **WHEN** `.github/pipeline.yml` has no `repo_map` block
- **THEN** `config.repo_map.depends_on` SHALL equal `[]`
- **AND** `config.repo_map.depended_on_by` SHALL equal `[]`

#### Scenario: unknown sub-key under repo_map rejected

- **WHEN** `.github/pipeline.yml` sets an unrecognized key under `repo_map` (e.g. `consumes: [acme/x]`)
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the offending key

#### Scenario: malformed owner/repo entry rejected

- **WHEN** `repo_map.depends_on` contains an entry that is not `owner/repo`-shaped (e.g. `just-a-name` or `a/b/c`)
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the offending entry

### Requirement: `pipeline config schema` SHALL expose the repo_map block

The JSON Schema emitted by `pipeline config schema` SHALL include a `repo_map` property
derived from `PartialConfigSchema`, whose `depends_on` and `depended_on_by` sub-properties are
each typed as an array of strings and carry a non-empty `description`. `repo_map` SHALL be
absent from the schema's top-level `required` array (it is optional).

#### Scenario: schema includes repo_map with accurate types

- **WHEN** the user runs `pipeline config schema`
- **THEN** the emitted JSON Schema SHALL include a `repo_map` property
- **AND** `repo_map.properties.depends_on` SHALL describe an array of strings with a non-empty `description`
- **AND** `repo_map.properties.depended_on_by` SHALL describe an array of strings with a non-empty `description`
- **AND** `repo_map` SHALL NOT appear in the schema's top-level `required` array
