## ADDED Requirements

### Requirement: Config SHALL accept an optional planning_facts block

`PartialConfigSchema` SHALL accept an optional `planning_facts` key. When absent, resolved config SHALL expose no providers and planning-facts observation SHALL be a no-op. When present, the block SHALL validate against a strict sub-schema with:

- `providers` (array, default empty): each entry SHALL have:
  - `id` (non-empty string, unique within the list)
  - `executable` (repo-relative path; no absolute path; no `..` segment)
  - `args` (optional array of strings; default empty)
  - `required` (boolean)
  - `facts` (non-empty object mapping fact ids to a closed type enum of primitives and arrays of primitives)
- optional ceiling keys that MAY only lower pipeline-owned ceilings for runtime, stdout, stderr, fact count, key size, value size, and total prompt contribution

An unknown key under `planning_facts` or under a provider entry SHALL be rejected by strict schema validation. A ceiling above the pipeline-owned maximum SHALL be rejected. Duplicate provider `id` values SHALL be rejected. Duplicate fact ids across providers SHALL be rejected. An `executable` that is absolute or that contains a `..` segment SHALL be rejected.

#### Scenario: Absent block equals no providers

- **WHEN** `.github/pipeline.yml` omits `planning_facts`
- **THEN** `resolveConfig()` SHALL succeed
- **AND** the resolved config SHALL have an empty providers list

#### Scenario: Valid provider is accepted

- **WHEN** `.github/pipeline.yml` sets:
  ```yaml
  planning_facts:
    providers:
      - id: alembic-head
        executable: scripts/pipeline/planning-facts/alembic-head
        required: true
        facts:
          alembic_head: string
  ```
- **THEN** `resolveConfig()` SHALL accept it
- **AND** SHALL expose one required provider with that executable and fact map

#### Scenario: Unknown key under planning_facts is rejected

- **WHEN** `.github/pipeline.yml` sets `planning_facts: { auto_detect: true }`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `auto_detect`

#### Scenario: Absolute or parent-escaping executable is rejected

- **WHEN** a provider `executable` is `/usr/bin/python` or `scripts/../../outside`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `executable`

#### Scenario: Raised ceiling is rejected

- **WHEN** a repository sets a `planning_facts` timeout above the pipeline-owned ceiling
- **THEN** `resolveConfig()` SHALL throw a parse error identifying that ceiling key

#### Scenario: Duplicate provider ids are rejected

- **WHEN** two providers share the same `id`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the duplicate id

#### Scenario: Duplicate fact ids across providers are rejected

- **WHEN** two providers both declare fact id `alembic_head`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the duplicate fact id
