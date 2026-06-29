## ADDED Requirements

### Requirement: Init scaffolds a commented-out documented `repo_map` block

The `.github/pipeline.yml` scaffolded by `init` (and by `config sync`) SHALL include a
`repo_map` block that is commented out by default, with inline documentation describing the
two relationship lists (`depends_on`, `depended_on_by`), the `owner/repo` entry format, and
that the relationship is declared independently per repo. Because the block is commented out,
the scaffolded file SHALL still round-trip through `resolveConfig()` to the `repo_map` default
(both lists empty), preserving the existing "scaffolded config equals defaults" guarantee.

#### Scenario: scaffolded config contains the documented repo_map block

- **WHEN** `init` scaffolds `.github/pipeline.yml`
- **THEN** the file SHALL contain a commented-out `repo_map` block
- **AND** the block's comments SHALL document `depends_on`, `depended_on_by`, and the `owner/repo` entry format

#### Scenario: scaffolded repo_map keeps the config valid against defaults

- **WHEN** the scaffolded `.github/pipeline.yml` is parsed by `resolveConfig()`
- **THEN** parsing SHALL succeed
- **AND** `config.repo_map.depends_on` SHALL equal `[]`
- **AND** `config.repo_map.depended_on_by` SHALL equal `[]`
