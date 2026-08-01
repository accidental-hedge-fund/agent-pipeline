## MODIFIED Requirements

### Requirement: Optional and advanced topics are visually separated from core flow

Advanced, optional, or less-common topics — including OpenSpec integration, last30days context, configurable steps, eval gate, and development — SHALL appear either (a) in README sections that are clearly labeled as optional/advanced and positioned after the core getting-started flow, or (b) in the linked `docs/concepts.md` companion (or other linked docs pages) that the README points to after the core flow. A newcomer SHALL be able to reach a working setup without reading optional/advanced README sections or any `docs/` companion page. Companion review modes are removed and SHALL NOT appear as optional topics.

#### Scenario: Newcomer can reach working setup without reading optional sections

- **WHEN** a first-time reader follows only the prerequisite, install, and quickstart sections of the README
- **THEN** they SHALL reach a working setup without requiring information from any optional/advanced README section or from `docs/cli.md`, `docs/config.md`, or `docs/concepts.md`

#### Scenario: Optional sections are labeled

- **WHEN** a section covers an optional feature (in the README or in `docs/concepts.md`)
- **THEN** the section heading or lead sentence SHALL indicate the feature is optional (e.g. "(optional)", "default off", or similar)

### Requirement: README is navigable without reading in full

The README SHALL be skimmable and anchor-navigable: it SHALL use a consistent heading hierarchy (one H1, logical H2/H3 sections), section titles that reflect their content, and working anchor links, a table of contents, and/or explicit links to `docs/` companions so a returning user can jump directly to install, usage, configuration, or troubleshooting without reading the entire document. Configuration reference detail MAY live in `docs/config.md` and CLI reference detail MAY live in `docs/cli.md`, provided the README exposes clear links to those pages.

#### Scenario: Returning user can locate configuration section quickly

- **WHEN** a returning user needs to find the per-repo configuration reference
- **THEN** there SHALL be a README section heading and/or link that leads directly to the `.github/pipeline.yml` config reference in `docs/config.md` (or an in-README config section) without requiring a full read of the README body

#### Scenario: Heading hierarchy is consistent

- **WHEN** the README is parsed as Markdown
- **THEN** there SHALL be exactly one H1 (`#`) heading; all top-level sections SHALL use H2 (`##`); subsections SHALL use H3 (`###`) without skipping levels

### Requirement: All instructions are accurate to current tool behavior

Every instruction, command, flag, and description in the README and in the linked operator docs companions it presents as authoritative (`docs/cli.md`, `docs/config.md`, and `docs/concepts.md`) SHALL reflect the tool's actual behavior as of the change. No step SHALL contradict how the installer, pipeline commands, reviewer wiring, or config keys currently work.

#### Scenario: Install commands match installer implementation

- **WHEN** a reader runs any install command shown in the README
- **THEN** the command SHALL execute without error against the current installer (flags, env vars, and host names used in examples SHALL be valid)

#### Scenario: Reviewer wiring description matches default behavior

- **WHEN** the README or `docs/concepts.md` describes how review is invoked
- **THEN** it SHALL accurately describe the `reviewMode: prompt-harness` path (direct CLI invocation with a JSON prompt, no plugin required); the companion modes (`claude-companion`, `codex-companion`) SHALL NOT be mentioned as valid or optional alternatives

#### Scenario: Config key examples are valid

- **WHEN** the README or `docs/config.md` shows a `.github/pipeline.yml` example block
- **THEN** every key shown SHALL be a currently recognized config key; no schema-rejected or non-existent keys (for example `auto_merge`) SHALL appear as supported options
