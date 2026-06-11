## MODIFIED Requirements

### Requirement: Archive into living specs at finalize

At pre-merge the change SHALL be archived (`openspec archive`) — folding its spec deltas into `openspec/specs/` and moving the change under `openspec/changes/archive/` — and `openspec validate --all` SHALL pass before the item reaches `ready-to-deploy`. Before calling `openspec archive`, the pre-merge stage SHALL run a consistency guard that blocks a stale-delta archive. The guard SHALL block when ALL of: (1) a non-pipeline commit on the branch changed implementation files in a commit ordered after the last commit that changed the change's `specs/**` (order-aware file-path check), AND (2) the most recent review verdict contains a finding tagged with the structured category `spec-divergence`. The guard SHALL read condition (2) from the structured category marker emitted into the review comment, and SHALL NOT infer divergence by keyword-matching the reviewer's free-text prose.

#### Scenario: archive on finalize when spec and code are consistent

- **WHEN** an OpenSpec-active item reaches pre-merge
- **AND** the consistency guard does not detect a code-spec divergence
- **THEN** its change SHALL be archived into the living specs and `openspec validate --all` SHALL pass before advancing

#### Scenario: pre-merge blocks when code moved but spec did not and a finding is tagged spec-divergence

- **WHEN** an OpenSpec-active item reaches pre-merge
- **AND** a non-pipeline commit changed implementation files after the last commit that changed the change's `specs/**`
- **AND** the most recent review verdict contains a finding tagged `category: spec-divergence`
- **THEN** the pre-merge stage SHALL block with a reason naming the stale-delta condition
- **AND** SHALL NOT call `openspec archive`

#### Scenario: pre-merge proceeds when no finding is tagged spec-divergence

- **WHEN** an OpenSpec-active item reaches pre-merge
- **AND** implementation files changed but the change's `specs/**` did not
- **AND** no review finding is tagged `category: spec-divergence` (even if a finding's prose mentions "diverges" or "spec")
- **THEN** the consistency guard SHALL NOT block
- **AND** the archive step SHALL proceed normally

#### Scenario: the consistency guard ignores prose

- **WHEN** the most recent review verdict contains a finding whose body mentions a spec divergence in prose but carries no `category: spec-divergence` marker
- **THEN** the consistency guard SHALL treat it as no divergence flag and SHALL NOT block on that basis
