## ADDED Requirements

### Requirement: Target repos MAY maintain a human-curated lessons section in their conventions file

A target repo MAY include a `#### Lessons / Gotchas` section (or equivalent named section) inside the file resolved by `readConventions` (`conventions_md_path`, else `conventions_default ?? "CLAUDE.md"`). The pipeline SHALL treat this section as ordinary conventions content: it is read and injected into stage prompts identically to any other conventions text. No special parsing, no dedicated config key, and no pipeline-side extraction or mutation of this content is required.

#### Scenario: Lessons section in conventions file is included in planning prompt

- **WHEN** a target repo's conventions file contains a lessons section
- **AND** the pipeline advances an issue through the planning stage
- **THEN** the planning prompt SHALL contain the lessons content as part of the injected conventions block
- **AND** the lessons content SHALL require no configuration beyond the existing `conventions_md_path` / `CLAUDE.md` default

#### Scenario: Lessons section in conventions file is included in review prompts

- **WHEN** a target repo's conventions file contains a lessons section
- **AND** the pipeline advances an issue through a review stage (standard or adversarial)
- **THEN** the review prompt SHALL contain the lessons content as part of the injected conventions block

#### Scenario: Lessons section in conventions file is included in fix prompts

- **WHEN** a target repo's conventions file contains a lessons section
- **AND** the pipeline advances an issue through a fix stage
- **THEN** the fix prompt SHALL contain the lessons content as part of the injected conventions block

#### Scenario: Lessons section beyond the readConventions excerpt cap is preserved in stage prompts

- **WHEN** a target repo's conventions file is longer than the `readConventions` excerpt cap (default 8 000 chars)
- **AND** a lessons section heading (`#### Lessons` or equivalent) appears after the cap
- **THEN** `readConventions` SHALL include the lessons section in the returned excerpt
- **AND** a truncation marker SHALL appear between the beginning of the file and the preserved lessons section

### Requirement: The pipeline SHALL NOT write to or create the conventions file

No pipeline code path — planning, review, fix, pre-merge, eval, deploy-ready, or auto-recover — SHALL create, overwrite, or append to the file resolved by `readConventions`. Labels and issue/PR comments remain the only pipeline-owned state; the conventions file is owned entirely by the repo maintainer.

#### Scenario: Pipeline run with an existing conventions file leaves it unchanged

- **WHEN** a target repo has a conventions file present before a pipeline run
- **THEN** after any number of pipeline stage executions, the conventions file's content and mtime SHALL be unchanged
- **AND** no pipeline stage SHALL open the file for writing

#### Scenario: Pipeline run on a repo without a conventions file does not create one

- **WHEN** a target repo has no file at the `readConventions` resolved path before a pipeline run
- **THEN** after any number of pipeline stage executions, no conventions file SHALL have been created at that path

### Requirement: Repos without a conventions file SHALL receive the readConventions stub and be unaffected

`readConventions` already returns `"(no conventions file found — agents will use repo conventions inferred from the codebase)"` when the resolved path does not exist. This behavior SHALL be preserved: the stub is injected in place of lessons/conventions content, all prompts remain structurally valid, and no stage SHALL block or error due to a missing conventions file.

#### Scenario: Missing conventions file renders the readConventions stub

- **WHEN** no file exists at the path resolved by `readConventions`
- **THEN** `readConventions` SHALL return the stub string and SHALL NOT throw
- **AND** planning, review, and fix prompts SHALL include the stub in place of conventions content

#### Scenario: All stages remain functional without a conventions file

- **WHEN** no conventions file is present in the target repo
- **THEN** every stage prompt builder SHALL complete without error
- **AND** the pipeline SHALL NOT block, skip, or error due to absent conventions content

### Requirement: The conventions / lessons convention SHALL be described in user-facing documentation

The agent-pipeline README and SKILL.md SHALL include a section documenting: (a) that the pipeline reads the conventions file into every stage prompt, (b) that maintainers MAY add a lessons/gotchas section to carry forward recurring patterns, and (c) that the pipeline never writes to this file.

#### Scenario: Documentation describes the lessons convention

- **WHEN** a user reads the agent-pipeline README or SKILL.md
- **THEN** they SHALL find an explanation of the conventions file injection
- **AND** an explicit note that the file is read-only from the pipeline's perspective
- **AND** guidance that a lessons / gotchas section is a supported pattern for carry-forward context
