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
Advanced, optional, or less-common topics — including OpenSpec integration, last30days context, configurable steps, eval gate, and development — SHALL appear in sections that are clearly labeled as optional/advanced and positioned after the core getting-started flow, so a newcomer can reach a working setup without reading through advanced content. Companion review modes are removed and SHALL NOT appear as optional topics.

#### Scenario: Newcomer can reach working setup without reading optional sections
- **WHEN** a first-time reader follows only the prerequisite, install, and quickstart sections
- **THEN** they SHALL reach a working setup without requiring information from any optional/advanced section

#### Scenario: Optional sections are labeled
- **WHEN** a section covers an optional feature
- **THEN** the section heading or lead sentence SHALL indicate the feature is optional (e.g., "(optional)", "default off", or similar)

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
- **THEN** it SHALL accurately describe the `reviewMode: prompt-harness` path (direct CLI invocation with a JSON prompt, no plugin required); the companion modes (`claude-companion`, `codex-companion`) SHALL NOT be mentioned as valid or optional alternatives

#### Scenario: Config key examples are valid
- **WHEN** the README shows a `.github/pipeline.yml` example block
- **THEN** every key shown SHALL be a currently recognized config key; no deprecated or non-existent keys (`auto_merge`, `harnesses`) SHALL appear

### Requirement: Formatting and code blocks render correctly on GitHub
All Markdown formatting SHALL follow GitHub-Flavored Markdown conventions: fenced code blocks SHALL specify a language hint where appropriate, inline code SHALL use backticks, links SHALL be valid and resolvable, and no mixed or inconsistent heading/list styles SHALL appear in the same section.

#### Scenario: Code blocks have language hints
- **WHEN** a fenced code block contains shell commands or YAML
- **THEN** the opening fence SHALL include a language identifier (`bash`, `yaml`, `json`, etc.)

#### Scenario: No broken links
- **WHEN** the document contains a hyperlink
- **THEN** the link SHALL resolve to a real resource (no 404, no placeholder anchors)

### Requirement: README install pins SHALL not recommend obsolete release tags

README install pins SHALL not recommend obsolete release tags. Install examples
that pin a GitHub ref (`#vX.Y.Z` or `git checkout vX.Y.Z`) SHALL either use a
release tag that matches the repository’s current package version major.minor.patch
at the time of the change, or describe pinning without embedding a historically
obsolete version number. The README SHALL NOT present `v1.2.1` (or any other
abandoned line) as the recommended or worked-example pin when the package version
is on a later major/minor line.

#### Scenario: Recommended install does not cite a stale pin

- **WHEN** a reader follows the highlighted recommended install command(s)
- **THEN** the command(s) SHALL NOT pin `#v1.2.1` or another obsolete tag as if
  it were current
- **AND** any pin shown SHALL either match the current package release tag or
  use unversioned / “pick a released tag from GitHub Releases” wording

#### Scenario: Specific-version section avoids ancient hardcoded examples

- **WHEN** the README documents installing a specific version
- **THEN** worked examples SHALL NOT use `v1.2.1` as the only illustrated pin
  when the package is past the 1.2 line
- **AND** the section SHALL remain accurate for how `npx github:…#<tag>` works

### Requirement: README SHALL describe durable loop without requiring external goal-loop

README SHALL describe durable multi-item loop without requiring external
goal-loop. Text about `pipeline:loop` / durable multi-item runs and about the
doctor check `loop:contract-coherence` SHALL match in-repo loop reality: durable
loop does not require an externally installed goal-loop skill. The README SHALL
NOT state that goal-loop must be installed for `/pipeline:loop` or
`$pipeline:loop` to work. Where `loop:contract-coherence` is documented, absence
of goal-loop SHALL be described as non-failing (skip/warn/optional), not as a
hard doctor failure or install blocker.

#### Scenario: Loop section does not require goal-loop

- **WHEN** a reader reads the durable multi-item / `pipeline:loop` section
- **THEN** the section SHALL NOT require installing goal-loop as a prerequisite
  for loop
- **AND** it SHALL be consistent with the in-repo durable loop supervisor

#### Scenario: Doctor table matches optional goal-loop semantics

- **WHEN** the README documents the `loop:contract-coherence` doctor check
- **THEN** it SHALL NOT claim the check fails solely because goal-loop is absent
- **AND** it SHALL NOT claim `pipeline:loop` itself requires that check to pass
  via an external goal-loop install

