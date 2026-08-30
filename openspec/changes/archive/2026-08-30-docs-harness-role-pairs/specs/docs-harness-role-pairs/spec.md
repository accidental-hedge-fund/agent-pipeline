## Purpose

Operator documentation treats implementer and reviewer as repository config roles, shows the configured pair plus `steps.adversarial_review` as a matrix, and names the `pipeline` CLI as the product command.

## ADDED Requirements

### Requirement: In-scope operator docs SHALL describe implementer and reviewer as config roles

`README.md`, `openspec/project.md`, `docs/supervisor.md`, and `docs/concepts.md` SHALL describe implementer and reviewer as roles declared in `.github/pipeline.yml` under `harnesses.implementer` and `harnesses.reviewer`. Those files SHALL NOT present Claude, Codex, or any other brand as the fixed product pair. Those files SHALL NOT state that both the Claude CLI and the Codex CLI are required for every install.

#### Scenario: Roles are named from config keys

- **WHEN** a reader opens `README.md`, `openspec/project.md`, `docs/supervisor.md`, or `docs/concepts.md`
- **THEN** implementer and reviewer SHALL be described as `.github/pipeline.yml` roles
- **AND** the text SHALL name `harnesses.implementer` and `harnesses.reviewer` or an equivalent `harnesses:` pair block

#### Scenario: No Claude-versus-Codex product sentence remains

- **WHEN** those four files are searched for leftover exclusive product language
- **THEN** they SHALL NOT contain “must be Claude vs Codex”, “Claude↔Codex-only”, or “both Claude and Codex CLIs are required for every install”
- **AND** they SHALL NOT state that LLM budget comes only from `claude` / `codex` subscriptions

---

### Requirement: docs/concepts.md SHALL publish a role matrix from harnesses and adversarial_review

`docs/concepts.md` SHALL include a role matrix whose columns are sourced from `harnesses.implementer`, `harnesses.reviewer`, and `steps.adversarial_review`. The matrix SHALL include the worked pairs Grok implement / Codex review (this repository) and Codex implement / Claude review. Adjacent prose SHALL state that an independent reviewer is the default product and that one-harness self-review is fallback, not the recommended setup. Root `README.md` SHALL point to that matrix and SHALL NOT embed the full matrix.

#### Scenario: Matrix columns match config keys

- **WHEN** a reader opens the implementer/reviewer section of `docs/concepts.md`
- **THEN** the document SHALL contain a table whose columns include implementer, reviewer, and `steps.adversarial_review`
- **AND** those columns SHALL be described as coming from `.github/pipeline.yml`

#### Scenario: Worked pairs are present

- **WHEN** a reader reads that matrix
- **THEN** it SHALL include a row for Grok implementer with Codex reviewer (this repository)
- **AND** it SHALL include a row for Codex implementer with Claude reviewer

#### Scenario: Self-review is not the default product

- **WHEN** a reader reads the matrix or the adjacent prose
- **THEN** the text SHALL state that an independent reviewer is required as the default product
- **AND** it SHALL state that same-harness self-review is fallback, not the recommended setup

#### Scenario: README stays a pointer

- **WHEN** a reader opens root `README.md`
- **THEN** the document SHALL contain a working relative link to the concepts role-matrix section
- **AND** `README.md` SHALL contain fewer than 400 lines
- **AND** the README body SHALL NOT reproduce the full matrix table

---

### Requirement: In-scope docs SHALL point at pipeline doctor for the resolved pair

`README.md`, `docs/concepts.md`, and `docs/supervisor.md` SHALL name `pipeline doctor` as the command that reports the resolved implementer and reviewer harnesses. That pointer SHALL describe existing doctor `harness:<bin>` checks for the configured roles. The docs SHALL NOT require a new doctor check, a new summary banner, or a change to harness resolution.

#### Scenario: Doctor is the resolved-pair surface

- **WHEN** a reader follows the role-matrix pointer or supervisor prerequisites
- **THEN** the text SHALL name `pipeline doctor`
- **AND** it SHALL state that doctor reports the configured implementer and reviewer harnesses

#### Scenario: No new doctor machinery is specified

- **WHEN** this capability is implemented
- **THEN** doctor behavior SHALL remain the existing `harness:<bin>` checks for `harnesses.implementer` and `harnesses.reviewer`
- **AND** no new doctor check id SHALL be required

---

### Requirement: In-scope docs SHALL link steps.adversarial_review to the generated config reference

Operator text in `README.md`, `docs/concepts.md`, `docs/supervisor.md`, or `openspec/project.md` that describes review-1 / review-2 SHALL name `steps.adversarial_review` and SHALL include a working relative link to `docs/config.md` (the generated key). The docs SHALL state that `steps.adversarial_review` toggles review-2 and its fix round and SHALL NOT present adversarial review as a second fixed brand.

#### Scenario: Adversarial review is a config flag

- **WHEN** a reader opens the configurable-steps or role-matrix section of `docs/concepts.md`
- **THEN** the text SHALL name `steps.adversarial_review`
- **AND** it SHALL contain a relative link to `docs/config.md`
- **AND** it SHALL describe the flag as toggling review-2 and its fix round

---

### Requirement: Operator first-run SHALL use the pipeline CLI as the product command

README Quickstart first-run and Onboarding, and the `docs/concepts.md` post-init invoke line, SHALL use `pipeline N` as the product command. Those first-run surfaces SHALL NOT present Claude Code `/pipeline` or Codex `$pipeline` as the required product command. Across `README.md`, `openspec/project.md`, `docs/supervisor.md`, and `docs/concepts.md`, Claude Code `/pipeline` and Codex `$pipeline` SHALL appear at most once, labeled as a historical or host-shim alias. Host-specific install subsections MAY still name that host’s native command (OpenCode `/pipeline`, OMP `/pipeline`) as an install artifact. Command examples in those four files that are not host-install artifacts SHALL use `pipeline` CLI form (for example `pipeline N --override`, not `/pipeline N --override`).

#### Scenario: First-run uses the CLI

- **WHEN** a reader follows README Quickstart after install, or README Onboarding after `pipeline init`
- **THEN** the invoke command SHALL be `pipeline N`
- **AND** that first-run block SHALL NOT require `/pipeline N` or `$pipeline N`

#### Scenario: Concepts post-init uses the CLI

- **WHEN** a reader follows the `docs/concepts.md` onboarding paragraph after `pipeline init`
- **THEN** the invoke command SHALL be `pipeline N`
- **AND** it SHALL NOT be `/pipeline N` or `$pipeline N`

#### Scenario: Historical slash names appear at most once

- **WHEN** `README.md`, `openspec/project.md`, `docs/supervisor.md`, and `docs/concepts.md` are searched for Claude Code `/pipeline` and Codex `$pipeline` as product invocation tokens
- **THEN** that pair SHALL appear in at most one labeled historical or host-shim note
- **AND** OpenCode and OMP host-install subsections MAY still name their native `/pipeline` command as an install artifact
