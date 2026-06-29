## ADDED Requirements

### Requirement: The engine SHALL identify cross-repo dependencies when repo_map is configured

The roadmap engine's dependency phase SHALL identify cross-repo dependencies whenever
`repo_map` is configured with at least one declared repo. It SHALL fetch the open issues of
each distinct declared repo and identify cross-repo dependencies: local backlog issues whose
work relates to a declared repo (because the local issue text references a declared repo or one
of its open issues, or because the declared relationship direction implies a sequencing hint).
Identified cross-repo dependencies SHALL be recorded in `plan.json` under
`dependency_graph.cross_repo[]`. Each
entry SHALL identify the local issue, the declared `owner/repo`, the relationship direction
(`depends_on` or `depended_on_by`), and a rationale. Cross-repo dependencies SHALL be
surfaced as annotations for human sequencing — they SHALL NOT be merged into this repo's
`must_precede`/`should_precede` topological sort, because the engine orders only this repo's
backlog (running the advance loop across multiple repos is out of scope).

#### Scenario: cross-repo dependency recorded in plan.json

- **WHEN** `repo_map.depends_on` lists `acme/shared-lib` and a local issue references work in `acme/shared-lib`
- **THEN** `plan.json.dependency_graph.cross_repo[]` SHALL contain an entry naming the local issue, `acme/shared-lib`, the direction `depends_on`, and a rationale

#### Scenario: cross-repo edges do not enter the local topological sort

- **WHEN** a cross-repo dependency to `acme/shared-lib` is identified for local issue #5
- **THEN** the entry SHALL appear in `dependency_graph.cross_repo[]`
- **AND** no `acme/shared-lib` issue SHALL be inserted into `dependency_graph.must_precede[]` or the local `roadmap[]` ordering

#### Scenario: repo_map absent — cross_repo is empty and behavior unchanged

- **WHEN** `.github/pipeline.yml` has no `repo_map` block
- **THEN** the engine SHALL make no cross-repo issue fetch
- **AND** `plan.json.dependency_graph.cross_repo[]` SHALL be an empty array

#### Scenario: unreachable declared repo is skipped with a warning

- **WHEN** a declared repo cannot be read during the dependency phase
- **THEN** the engine SHALL log a named warning identifying that `owner/repo`
- **AND** SHALL continue producing the plan without that repo's cross-repo edges rather than aborting

### Requirement: `roadmap.md` SHALL surface a cross-repo dependencies section when present

When `dependency_graph.cross_repo[]` is non-empty, `roadmap.md` SHALL include a cross-repo
dependencies section listing each identified cross-repo dependency with its local issue, the
declared `owner/repo`, the relationship direction, and the rationale, so a human can sequence
work correctly across repo boundaries. When `cross_repo[]` is empty, the section MAY be
omitted.

#### Scenario: cross-repo section rendered when entries exist

- **WHEN** `plan.json.dependency_graph.cross_repo[]` contains at least one entry
- **THEN** `roadmap.md` SHALL include a cross-repo dependencies section
- **AND** each entry SHALL show the local issue, the declared `owner/repo`, the direction, and the rationale

#### Scenario: cross-repo section omitted when empty

- **WHEN** `plan.json.dependency_graph.cross_repo[]` is empty
- **THEN** `roadmap.md` SHALL render exactly as before this capability (the cross-repo section MAY be omitted)
