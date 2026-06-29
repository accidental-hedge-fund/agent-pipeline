# namespaced-command-surface Specification

## Purpose
TBD - created by archiving change namespaced-command-surface. Update Purpose after archive.
## Requirements
### Requirement: Each in-scope operation SHALL be exposed as a distinct `pipeline:<command>` host entry

The host packaging SHALL expose each in-scope pipeline operation as its own
discoverable `pipeline:<command>` command entry, rather than as a flag on a single
`/pipeline` command. The in-scope operation set SHALL be exactly: `status`,
`unblock`, `override`, `summary`, `doctor`, `init`, `cleanup`, `intake`, `sweep`,
`triage`, `merge`, `release`, `roadmap`, `logs`. On the Claude host these entries
SHALL be invocable as `/pipeline:<command>`; on the Codex host they SHALL be
invocable as `$pipeline:<command>`. Each entry SHALL appear in that host's
command/skill discovery surface.

#### Scenario: Every in-scope operation has a host command entry

- **WHEN** the host command surface generated for Claude is enumerated
- **THEN** it SHALL contain a `pipeline:status`, `pipeline:unblock`,
  `pipeline:override`, `pipeline:summary`, `pipeline:doctor`, `pipeline:init`,
  `pipeline:cleanup`, `pipeline:intake`, `pipeline:sweep`, `pipeline:triage`,
  `pipeline:merge`, `pipeline:release`, `pipeline:roadmap`, and `pipeline:logs`
  entry
- **AND** no in-scope operation SHALL be reachable only as a flag on the base
  `/pipeline` command

#### Scenario: A migrated operation is discoverable in the menu

- **WHEN** a developer opens the Claude Code skill/command menu
- **THEN** `pipeline:status` (and each other in-scope entry) SHALL be listed as a
  named command with its own description, without the developer needing to know
  any flag syntax

---

### Requirement: The host command set SHALL be symmetric across Claude and Codex

The `pipeline:<command>` entries SHALL be generated from a single source so that
the Claude host (`/pipeline:<command>`) and the Codex host (`$pipeline:<command>`)
expose the identical operation set with identical argument contracts and identical
target behavior. Neither host SHALL carry an in-scope entry the other lacks.

#### Scenario: Codex exposes the same set as Claude

- **WHEN** the host command surfaces for Claude and Codex are compared
- **THEN** the set of in-scope operation names SHALL be identical on both hosts
- **AND** `$pipeline:triage` (Codex) SHALL perform the same operation with the
  same arguments as `/pipeline:triage` (Claude)

#### Scenario: Adding an operation updates both hosts from one source

- **WHEN** a new in-scope operation is added to the single source list and
  `scripts/build.mjs` is run
- **THEN** both the Claude `commands/` surface and the Codex overlay SHALL gain
  the corresponding entry, and the `plugin/` mirror SHALL regenerate to match

---

### Requirement: Each `pipeline:<command>` entry SHALL forward to the equivalent CLI invocation

Each host command entry SHALL forward to the underlying pipeline CLI invocation
for that operation, preserving the operation's existing behavior, arguments, and
output. The mapping SHALL be: `pipeline:status <N>` → the read-only status mode;
`pipeline:unblock <N> "<answer>"` → post-answer/clear-blocked; `pipeline:override
<N> "<spec>"` → disposition-and-resume; `pipeline:summary <N>` → issue N's
evidence-bundle dump; `pipeline:doctor` → standalone preflight; `pipeline:init` →
label-ensure + config scaffold; `pipeline:cleanup` → merged-worktree sweep; and
`pipeline:<intake|sweep|triage|merge|release|roadmap|logs>` → the existing
identically-named keyword sub-command.

#### Scenario: Host entry runs the same operation as the underlying command

- **WHEN** `/pipeline:status 42` is invoked
- **THEN** it SHALL produce the same stage/blocker/PR/last-review status output as
  the pre-existing read-only status mode for issue 42
- **AND** it SHALL NOT advance any pipeline stage label

#### Scenario: Issue-bundle summary entry targets the issue number

- **WHEN** `/pipeline:summary 42` is invoked
- **THEN** it SHALL print issue 42's evidence bundle (the per-issue dump), and the
  pre-existing `pipeline summary <run-id>` exact-run selector SHALL remain
  available and unchanged for run-id selection

---

### Requirement: The advance loop SHALL remain the default invocation, unchanged

The advance loop SHALL remain the default, no-sub-command invocation. `/pipeline N`
(Claude) and `$pipeline N` (Codex) — an issue or PR number with no sub-command —
SHALL continue to invoke the advance loop with identical behavior to before this
change. Promoting operations to `pipeline:<command>` entries SHALL NOT alter, gate,
or rename the no-sub-command advance invocation.

#### Scenario: Numeric invocation still advances

- **WHEN** `/pipeline 42` is invoked with no sub-command
- **THEN** the advance loop SHALL run for issue 42 exactly as it did before this
  change, with no new prefix, keyword, or flag required

---

### Requirement: Behavior-tuning modifier flags SHALL NOT be promoted to `:command` entries

Behavior-tuning modifier flags SHALL NOT be promoted to `pipeline:<flag>` entries.
The flags that tune behavior *within* a command — including `--dry-run`, `--once`,
`--domain`, `--base`, `--repo-path`, `--model`, `--json`, `--detach`,
`--timeout`, `--apply`, `--follow`, `--stage`, `--release`, `--description`,
`--next`, and `--repo` — SHALL remain `--` flags scoped to their command. The
`--doctor` preflight-gate flag (run preflight, then advance, abort on failure)
SHALL likewise be retained as a modifier and SHALL NOT be deprecated or removed by
this change.

#### Scenario: A modifier is not a standalone command

- **WHEN** the host command surface is enumerated
- **THEN** there SHALL be no `pipeline:dry-run`, `pipeline:once`,
  `pipeline:domain`, `pipeline:detach`, `pipeline:json`, or `pipeline:apply` entry
- **AND** `--dry-run`, `--once`, `--detach`, and the other modifiers SHALL still
  be accepted as flags within their respective commands

#### Scenario: The preflight-gate flag is preserved

- **WHEN** `/pipeline 42 --doctor` is invoked
- **THEN** the preflight checks SHALL run and, on success, the advance loop SHALL
  proceed for issue 42 (the gate-then-advance behavior), and `--doctor` SHALL NOT
  emit a deprecation notice

---

### Requirement: The migrated documentation SHALL reflect the new invocation shapes

The README and both hosts' SKILL.md mode/usage tables SHALL document each
operation in its `pipeline:<command>` / `$pipeline:<command>` form and SHALL mark
the legacy mode-selecting flag forms as deprecated. No in-scope operation SHALL be
documented solely in its legacy `--flag` form.

#### Scenario: Docs present the namespaced form

- **WHEN** the README and the Claude/Codex SKILL.md mode tables are inspected
- **THEN** each in-scope operation SHALL be shown as `/pipeline:<command>` /
  `$pipeline:<command>`
- **AND** the legacy flag forms (`--status`, `--summary`, `--unblock`,
  `--override`, `--init`, `--cleanup`) SHALL be annotated as deprecated

---

### Requirement: `renderClaudeCommand` SHALL produce YAML frontmatter that is syntactically valid

The `renderClaudeCommand(op, skillPath)` function in `scripts/build.mjs` SHALL emit command markdown files whose YAML frontmatter block (between the opening and closing `---` delimiters) is syntactically valid and parseable by a standard YAML parser. Specifically, the `argument-hint` field value SHALL be single-quoted when present so that YAML-significant characters — including `:` and `[` — in the hint string are not misinterpreted by parsers. Any single-quote characters within the hint value SHALL be escaped using the YAML single-quote escape convention (`''`).

#### Scenario: Generated command file frontmatter parses without error

- **WHEN** `renderClaudeCommand` is called for any operation in `OPERATION_SURFACE` that has an `argHint`
- **THEN** the emitted markdown file's YAML frontmatter SHALL parse without error
- **AND** the parsed frontmatter SHALL contain a `description` key whose value matches the operation's description string
- **AND** if `argHint` is present, the parsed `argument-hint` value SHALL equal the raw hint string with no extraneous quoting characters

#### Scenario: `argument-hint` values containing `:` or `[` are safe in YAML

- **WHEN** an operation's `argHint` contains a `:` or `[` character
- **THEN** `renderClaudeCommand` SHALL wrap the value in single quotes in the emitted frontmatter
- **AND** a conformant YAML parser SHALL return the plain string value (not a parse error or a mapping/sequence type)

---

### Requirement: `renderCodexCommand` SHALL produce YAML agent files suitable for Codex host discovery

The `scripts/build.mjs` module SHALL export a `renderCodexCommand(op)` function
that returns a YAML string for each entry in `OPERATION_SURFACE`. The YAML SHALL
contain an `interface:` block with `display_name`, `short_description`, and
`default_prompt` fields. `scripts/install.mjs` SHALL write one such file per
operation to `<codexSkillsDir>/pipeline/agents/pipeline-<name>.yaml` when
installing the Codex host, so that Codex agent discovery surfaces each
`$pipeline:<command>` as a distinct entry.

To allow `renderCodexCommand` to be imported and unit-tested without triggering
mirror-generation side effects, `scripts/build.mjs` SHALL guard its `main()`
invocation behind an ESM entry-point check
(`process.argv[1] === fileURLToPath(import.meta.url)`).

#### Scenario: `renderCodexCommand` produces a YAML string with `interface:` block

- **WHEN** `renderCodexCommand` is called for any operation in `OPERATION_SURFACE`
- **THEN** it SHALL return a non-empty string
- **AND** the string SHALL include an `interface:` key
- **AND** the string SHALL reference `pipeline:<name>` in both the `display_name`
  and `default_prompt` values

#### Scenario: `build.mjs` can be safely imported without executing `main()`

- **WHEN** `build.mjs` is imported as an ES module (e.g., via dynamic `import()`
  in a test)
- **THEN** the mirror-generation `main()` function SHALL NOT execute
- **AND** `renderCodexCommand` SHALL be accessible as a named export

