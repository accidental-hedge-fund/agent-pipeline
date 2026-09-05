## MODIFIED Requirements

### Requirement: Archive into living specs at finalize

At pre-merge the change SHALL be archived by `openspec archive` in machine-readable mode, folding its deltas into `openspec/specs/` and moving it under `openspec/changes/archive/`, and `openspec validate --all` SHALL pass before the item reaches `ready-to-deploy`. Archive success SHALL require both an explicit successful result for every intended change id and verification that each corresponding active change directory is absent from the authoritative post-archive candidate. Before archive, the pre-merge stage SHALL run the existing stale-delta consistency guard: it SHALL block when both a later non-pipeline implementation commit exists after the last delta-spec commit and the current structured review verdict carries `category: spec-divergence`. The guard SHALL read the category marker and SHALL NOT infer divergence from reviewer prose.

The change SHALL be archived only after every explicit checklist item in each active change's `tasks.md` is checked. An unchecked `- [ ]` item, including a nested item, SHALL block before `openspec archive` is invoked and SHALL identify the affected change and remaining count. A change for which OpenSpec supplies no optional checklist remains governed by structural validation. Archive automation SHALL NOT convert an incomplete implementation checklist into an archived contract.

#### Scenario: Archive on finalize when spec and code are consistent

- **WHEN** an OpenSpec-active item reaches pre-merge and the consistency guard does not detect a code-spec divergence
- **THEN** each active change SHALL be archived in machine-readable mode
- **AND** explicit archive results, active-directory removal, and `openspec validate --all` SHALL be verified before advancing

#### Scenario: Archive output without active-directory removal is not success

- **WHEN** the archive command exits successfully but an intended change directory remains active on the authoritative candidate
- **THEN** the archive gate SHALL emit a canonical `implementation-ci` diagnostic with blocker kind `openspec-invalid` and remain blocked
- **AND** it SHALL NOT record archive success or advance

#### Scenario: Pre-merge blocks when code moved but spec did not and a finding is tagged spec-divergence

- **WHEN** a non-pipeline commit changed implementation files after the last commit that changed the change's `specs/**`
- **AND** the most recent review verdict contains `category: spec-divergence`
- **THEN** pre-merge SHALL remain blocked with a diagnostic naming the stale-delta condition
- **AND** it SHALL NOT call `openspec archive`

#### Scenario: Pre-merge proceeds when no finding is tagged spec-divergence

- **WHEN** implementation files changed but the change's `specs/**` did not
- **AND** no review finding is tagged `category: spec-divergence`
- **THEN** the consistency guard SHALL NOT block on code/delta ordering alone
- **AND** archive evaluation SHALL proceed normally

#### Scenario: The consistency guard ignores prose

- **WHEN** a current review finding mentions spec divergence in prose but carries no structured `category: spec-divergence` marker
- **THEN** the consistency guard SHALL treat it as no divergence flag
- **AND** it SHALL NOT block on that prose alone

#### Scenario: Unchecked implementation tasks block archive

- **WHEN** an active OpenSpec change reaches pre-merge with one or more unchecked `tasks.md` items
- **THEN** pre-merge SHALL remain blocked as `openspec-invalid`
- **AND** `openspec archive` SHALL NOT be invoked
- **AND** the reason SHALL name the change and number of unchecked tasks

#### Scenario: Completed checklist permits normal archive evaluation

- **WHEN** every explicit task in each active change is checked
- **THEN** the completeness guard SHALL pass
- **AND** the existing consistency, archive, validation, commit, and push gates SHALL continue normally
