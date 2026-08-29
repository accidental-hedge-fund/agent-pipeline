# readme-user-clarity Specification

## Purpose
TBD - created by archiving change readme-user-clarity. Update Purpose after archive.

## Requirements

### Requirement: README opens with a purpose-first summary

The README SHALL communicate — within the first visible screenful, before any configuration detail or repository layout — what the tool does, who it is for, the implementer/reviewer pair declared in `.github/pipeline.yml`, and the core prerequisites (Node ≥ 24, git, gh, and the configured harness CLIs authenticated). It SHALL NOT state that both the Claude CLI and the Codex CLI are required as the product, regardless of which host is installed. Deeper harness-pair documentation remains issue #976.

#### Scenario: First screenful is informative

- **WHEN** a developer opens the README cold on GitHub
- **THEN** the first screen SHALL contain the tool's purpose, the implementer/reviewer pair model, and the prerequisite summary before any configuration block or repository layout
- **AND** it SHALL NOT say both Claude and Codex CLIs are required as the product

#### Scenario: Cross-harness prerequisite is visible before install

- **WHEN** a reader reaches the install section
- **THEN** the implementer/reviewer pair from repository config SHALL have been stated earlier in the document, not only inside install sub-sections
- **AND** that earlier text SHALL NOT require both `claude` and `codex` CLIs as the product

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

Every instruction, command, flag, and description in the README and in the linked authoritative operator docs (`docs/cli.md`, `docs/config.md`, and `docs/concepts.md`) SHALL reflect current behavior. No step SHALL contradict the installer, Pipeline commands, reviewer wiring, configuration schema, release path, or deployment boundary. The README SHALL distinguish ordinary stop-at-ready behavior from optional external supervisors that compose the CLI. It SHALL NOT imply that a shipped Hermes/Buzz grant factory is a Pipeline config key, a merge stage, or a default capability.

#### Scenario: Install commands match installer implementation

- **WHEN** a reader runs an install command shown in the README
- **THEN** the command SHALL execute against the current installer with valid flags, environment names, and host names

#### Scenario: Reviewer wiring description matches default behavior

- **WHEN** the README or `docs/concepts.md` describes review invocation
- **THEN** it SHALL accurately describe the configured prompt-harness path
- **AND** it SHALL NOT present removed companion modes as valid alternatives

#### Scenario: Config key examples are valid

- **WHEN** the README or `docs/config.md` shows a `.github/pipeline.yml` block
- **THEN** every key shown SHALL be recognized by the current schema
- **AND** no schema-rejected key such as `auto_merge` or a deployment grant SHALL appear as supported configuration

#### Scenario: Default and supervisor composition are distinct

- **WHEN** the README describes an external supervisor composing the CLI
- **THEN** it SHALL first state that normal advance and loop commands stop at `pipeline:ready-to-deploy`
- **AND** it SHALL state that the repository does not ship a Hermes/Buzz factory control plane
- **AND** it SHALL link the factory simplification plan or equivalent product direction

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
goal-loop. Text about `pipeline loop` / durable multi-item runs and about the
doctor check `loop:contract-coherence` SHALL match in-repo loop reality: durable
loop does not require an externally installed goal-loop skill. The README SHALL
NOT state that goal-loop must be installed for `pipeline loop` to work. Where
`loop:contract-coherence` is documented, absence
of goal-loop SHALL be described as non-failing (skip/warn/optional), not as a
hard doctor failure or install blocker.

#### Scenario: Loop section does not require goal-loop

- **WHEN** a reader reads the durable multi-item / `pipeline loop` section
- **THEN** the section SHALL NOT require installing goal-loop as a prerequisite
  for loop
- **AND** it SHALL be consistent with the in-repo durable loop supervisor

#### Scenario: Doctor table matches optional goal-loop semantics

- **WHEN** the README documents the `loop:contract-coherence` doctor check
- **THEN** it SHALL NOT claim the check fails solely because goal-loop is absent
- **AND** it SHALL NOT claim `pipeline loop` itself requires that check to pass
  via an external goal-loop install

### Requirement: README SHALL document the Grok Build skill path

The README SHALL include an install-adjacent subsection for Grok Build
consumers that documents how to obtain the pipeline skill under
`~/.grok/skills/pipeline`. The preferred documented method SHALL be a symlink
to the Claude-managed skill install; a copy MAY be documented as a secondary
option. The subsection SHALL state that Grok is not a first-class host overlay
with a separate `hosts/grok` SKILL.md package (or, if `--host grok` is
documented, SHALL describe path materialization only). The Grok subsection
SHALL appear after the primary Claude/Codex quickstart so newcomers can finish
the default install without reading Grok-specific layout first.

#### Scenario: Grok subsection is present and accurate

- **WHEN** a Grok Build user opens the README looking for skill install paths
- **THEN** the README SHALL document `~/.grok/skills/pipeline` as the Grok
  skill location
- **AND** SHALL prefer symlink-to-Claude (or the equivalent under
  `CLAUDE_CONFIG_DIR`) over inventing a third unrelated install tree

#### Scenario: Grok content does not block the primary quickstart

- **WHEN** a first-time reader follows only the primary Claude/Codex install
  and quickstart
- **THEN** they SHALL reach a working Claude or Codex setup without needing
  the Grok subsection

#### Scenario: Grok host status is not overstated

- **WHEN** the README describes Grok consumption
- **THEN** it SHALL NOT claim a full third packaged host overlay exists when
  the installer only supports Claude and Codex as first-class hosts
- **AND** if it documents `--host grok`, that command SHALL match the
  installer's implemented behavior

### Requirement: README Grok reinstall note SHALL survive Claude updates

The README Grok documentation SHALL include a reinstall or update note:
after updating the Claude-hosted skill, the operator SHALL re-create the Grok
symlink (or re-run the documented Grok install command when `--host grok`
exists) so the Grok path is not left dangling or stale.

#### Scenario: Update path is actionable from README alone

- **WHEN** an operator updates Claude's pipeline skill and uses Grok via
  symlink
- **THEN** the README SHALL state the follow-up step to refresh the Grok path
- **AND** the step SHALL be runnable from documented commands without reading
  installer source
