# readme-user-clarity Specification

## Purpose
TBD - created by archiving change readme-user-clarity. Update Purpose after archive.
## Requirements
### Requirement: README opens with a purpose-first summary
The README SHALL communicate — within the first visible screenful, before any configuration detail or repository layout — what the tool does, who it is for, the cross-harness model (both Claude Code and Codex are required), and the core prerequisites (Node ≥ 24, git, gh, both CLIs authenticated).

#### Scenario: First screenful is informative
- **WHEN** a developer opens the README cold on GitHub
- **THEN** the first screen SHALL contain the tool's purpose, the two-host model, and the prerequisite summary before any configuration block or repository layout

#### Scenario: Cross-harness prerequisite is visible before install
- **WHEN** a reader reaches the install section
- **THEN** the requirement for both `claude` and `codex` CLIs SHALL have been stated earlier in the document, not only inside install sub-sections

---

### Requirement: README contains a quickstart section
The README SHALL include a dedicated quickstart (or "Getting Started") section that provides one clearly recommended install path and a minimal first-run example that takes a reader from install to advancing a single issue — without requiring the reader to parse optional or advanced sections first.

#### Scenario: Single recommended install command is present
- **WHEN** a reader wants to install the tool for the first time
- **THEN** there SHALL be exactly one visually highlighted recommended command (the `npx github:...` one-liner) before alternatives are listed

#### Scenario: First-run example is present
- **WHEN** a reader completes the recommended install path
- **THEN** the quickstart SHALL show at minimum: how to add the first `pipeline:ready` label to an issue and the command to invoke the pipeline on it (`/pipeline N` or `$pipeline N`)

---

### Requirement: Optional and advanced topics are visually separated from core flow
Advanced, optional, or less-common topics — including OpenSpec integration, last30days context, configurable steps, eval gate, companion review modes, and development — SHALL appear in sections that are clearly labeled as optional/advanced and positioned after the core getting-started flow, so a newcomer can reach a working setup without reading through advanced content.

#### Scenario: Newcomer can reach working setup without reading optional sections
- **WHEN** a first-time reader follows only the prerequisite, install, and quickstart sections
- **THEN** they SHALL reach a working setup without requiring information from any optional/advanced section

#### Scenario: Optional sections are labeled
- **WHEN** a section covers an optional feature
- **THEN** the section heading or lead sentence SHALL indicate the feature is optional (e.g., "(optional)", "default off", or similar)

---

### Requirement: README is navigable without reading in full
The README SHALL be skimmable and anchor-navigable: it SHALL use a consistent heading hierarchy (one H1, logical H2/H3 sections), section titles that reflect their content, and working anchor links or a table of contents so a returning user can jump directly to install, usage, configuration, or troubleshooting without reading the entire document.

#### Scenario: Returning user can locate configuration section quickly
- **WHEN** a returning user needs to find the per-repo configuration reference
- **THEN** there SHALL be a section with a clear heading that leads directly to the `.github/pipeline.yml` config reference without requiring a full read

#### Scenario: Heading hierarchy is consistent
- **WHEN** the document is parsed as Markdown
- **THEN** there SHALL be exactly one H1 (`#`) heading; all top-level sections SHALL use H2 (`##`); subsections SHALL use H3 (`###`) without skipping levels

---

### Requirement: All instructions are accurate to current tool behavior
Every instruction, command, flag, and description in the README SHALL reflect the tool's actual behavior as of the change. No step SHALL contradict how the installer, pipeline commands, reviewer wiring, or config keys currently work.

#### Scenario: Install commands match installer implementation
- **WHEN** a reader runs any install command shown in the README
- **THEN** the command SHALL execute without error against the current installer (flags, env vars, and host names used in examples SHALL be valid)

#### Scenario: Reviewer wiring description matches default behavior
- **WHEN** the README describes how review is invoked
- **THEN** it SHALL accurately describe the default `reviewMode: prompt-harness` path (direct CLI invocation with a JSON prompt, no plugin required) and SHALL clearly distinguish this default from the optional companion modes

#### Scenario: Config key examples are valid
- **WHEN** the README shows a `.github/pipeline.yml` example block
- **THEN** every key shown SHALL be a currently recognized config key; no deprecated or non-existent keys SHALL appear

---

### Requirement: Formatting and code blocks render correctly on GitHub
All Markdown formatting SHALL follow GitHub-Flavored Markdown conventions: fenced code blocks SHALL specify a language hint where appropriate, inline code SHALL use backticks, links SHALL be valid and resolvable, and no mixed or inconsistent heading/list styles SHALL appear in the same section.

#### Scenario: Code blocks have language hints
- **WHEN** a fenced code block contains shell commands or YAML
- **THEN** the opening fence SHALL include a language identifier (`bash`, `yaml`, `json`, etc.)

#### Scenario: No broken links
- **WHEN** the document contains a hyperlink
- **THEN** the link SHALL resolve to a real resource (no 404, no placeholder anchors)

