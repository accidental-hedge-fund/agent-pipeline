# cli-product-packaging Specification

## Purpose
Defines the packaging product contract: the `pipeline` CLI is the product, hosts are argv wrappers, and docs must not treat `plugin/` or MCP as the distribution surface.

## Requirements

### Requirement: docs/packaging.md SHALL state the CLI product contract

The repository SHALL provide a hand-authored `docs/packaging.md` that states the product surface is the `pipeline` CLI invoked as `pipeline <verb> [--json]`, plus the event JSONL stream. That page SHALL state that hosts are argv or JSON wrappers (short SKILL shims) that exec the CLI and are not a second engine. That page SHALL state that a `/pipeline:*` slash-command pack is not required as the product. That page SHALL state that an MCP server is not required and is parked at issue #907. That page SHALL include one sentence that merge is operator-authorized and that this repository does not ship a grant factory, MessagingPort, or second control plane.

#### Scenario: Packaging page exists with the CLI contract

- **WHEN** a reader opens `docs/packaging.md`
- **THEN** the page SHALL exist
- **AND** it SHALL name `pipeline <verb> [--json]` plus event JSONL as the product surface

#### Scenario: Hosts are documented as shims

- **WHEN** a reader opens `docs/packaging.md`
- **THEN** the page SHALL describe hosts as argv or JSON wrappers / short SKILL shims
- **AND** it SHALL NOT describe a host as a second pipeline engine

#### Scenario: Slash-command pack is not the product

- **WHEN** a reader opens `docs/packaging.md`
- **THEN** the page SHALL state that a `/pipeline:*` slash-command pack is not required as the product

#### Scenario: MCP is not required

- **WHEN** a reader opens `docs/packaging.md`
- **THEN** the page SHALL state that an MCP server is not required
- **AND** it SHALL name issue #907 as parked

#### Scenario: Merge authority sentence is present

- **WHEN** a reader opens `docs/packaging.md`
- **THEN** the page SHALL state that merge is operator-authorized
- **AND** it SHALL state that this repository does not ship a grant factory, MessagingPort, or second control plane

---

### Requirement: Root README and docs/concepts.md SHALL link docs/packaging.md

Root `README.md` and `docs/concepts.md` SHALL each contain a working relative markdown link to `docs/packaging.md`. The README landing-page executable companion trio (`docs/cli.md`, `docs/config.md`, `docs/concepts.md`) SHALL remain unchanged in this slice.

#### Scenario: README links packaging

- **WHEN** a reader opens root `README.md`
- **THEN** the document SHALL contain a relative link to `docs/packaging.md`

#### Scenario: Concepts links packaging

- **WHEN** a reader opens `docs/concepts.md`
- **THEN** the document SHALL contain a relative link to `docs/packaging.md`

---

### Requirement: CONTEXT.md SHALL define the packaging grill terms as glossary only

The repository root SHALL keep a committed `CONTEXT.md`. That file SHALL define at least these terms: CLI, Host, Shim, Slash command, Plugin directory, OPERATION_SURFACE, and MCP server. `CONTEXT.md` SHALL remain glossary-only (term, meaning, avoid-list). It SHALL NOT contain implementation steps, code patches, or a task list. Extra glossary terms already present MAY remain.

#### Scenario: Grill terms are present

- **WHEN** a reader opens root `CONTEXT.md`
- **THEN** the file SHALL define CLI, Host, Shim, Slash command, Plugin directory, OPERATION_SURFACE, and MCP server

#### Scenario: Glossary remains non-implementing

- **WHEN** `CONTEXT.md` is inspected for implementation content
- **THEN** it SHALL NOT contain implementation steps, code patches, or a task checklist

---

### Requirement: Contributor docs SHALL present install CLI plus short SKILL, not copy core

Contributor-facing packaging docs (at least `docs/packaging.md`, and README Development when it speaks about how the product is consumed) SHALL present the contributor path as installing the `pipeline` CLI plus a short host SKILL that execs that CLI. Those docs SHALL NOT present copying `core/` into a committed plugin mirror, or treating a committed `plugin/` directory, as the product distribution. They SHALL NOT describe a remaining generated `plugin/` SKILL overlay or marketplace shell. They SHALL tell an operator whose `CLAUDE_PLUGIN_ROOT` still points at a leftover core copy to run `install --host claude` or pin.

#### Scenario: Contributor path names CLI plus SKILL

- **WHEN** a contributor reads `docs/packaging.md` for how to consume the product
- **THEN** the page SHALL tell them to install the CLI and a short host SKILL
- **AND** it SHALL NOT tell them to copy `core/` as the product

#### Scenario: plugin/ is transitional, not the product

- **WHEN** `docs/packaging.md` mentions `plugin/`
- **THEN** it SHALL describe `plugin/` as deleted / retired, not as a generated overlay that still ships
- **AND** it SHALL NOT describe `plugin/` as the distribution product

#### Scenario: leftover CLAUDE_PLUGIN_ROOT migration is documented

- **WHEN** a reader looks for how to leave a leftover marketplace core copy
- **THEN** packaging or install docs SHALL name `install --host claude` or pin as the remediation

### Requirement: AGENTS.md and CLAUDE.md golden rule 1 SHALL name CLI plus SKILL as the product

Repo-root `AGENTS.md` and `CLAUDE.md` golden rule #1 SHALL state that the product is the `pipeline` CLI plus a short host SKILL. Those files SHALL NOT state “always commit the regenerated `plugin/` core mirror” as the packaging rule. They SHALL describe `node scripts/build.mjs --check` as a generated SKILL/catalog freshness gate. `AGENTS.md` and `CLAUDE.md` SHALL stay in sync on this rule.

#### Scenario: AGENTS.md no longer states the forever mirror rule

- **WHEN** a contributor reads `AGENTS.md` golden rule #1
- **THEN** the rule SHALL name CLI plus SKILL as the product
- **AND** it SHALL NOT say always commit `plugin/` as the forever rule
- **AND** it SHALL state that `build.mjs --check` asserts SKILL/catalog freshness

#### Scenario: CLAUDE.md matches AGENTS.md

- **WHEN** a contributor compares repo-root `CLAUDE.md` golden rule #1 with `AGENTS.md` golden rule #1
- **THEN** both files SHALL name CLI plus SKILL as the product
- **AND** both SHALL carry the same SKILL/catalog freshness instruction

---

### Requirement: openspec/project.md SHALL not claim Claude-plus-Codex-only or forever mirror commit

`openspec/project.md` SHALL describe the product as the `pipeline` CLI with host shims. It SHALL NOT state that the product ships only for Claude Code and Codex. It SHALL NOT require a regenerated `plugin/` core mirror. It MAY mention `build.mjs --check` only as a generated SKILL/catalog freshness gate.

#### Scenario: project.md is not Claude-plus-Codex-only

- **WHEN** a reader opens `openspec/project.md`
- **THEN** the file SHALL NOT say the product ships only as a Claude Code and Codex skill pair
- **AND** it SHALL describe hosts as wrappers around the CLI

#### Scenario: project.md is not forever-mirror

- **WHEN** a reader opens `openspec/project.md`
- **THEN** the file SHALL NOT say always commit regenerated `plugin/` as the forever packaging rule

---

### Requirement: README SHALL describe an implementer/reviewer pair, not both CLIs required

Root `README.md` SHALL describe a runnable repository as declaring an implementer and a reviewer in `.github/pipeline.yml` (a role pair). It SHALL NOT state that both the Claude CLI and the Codex CLI are required as the product, regardless of which host is installed. Deeper harness-pair documentation remains issue #976.

#### Scenario: README uses pair language

- **WHEN** a reader opens the README purpose or prerequisites section
- **THEN** the text SHALL describe an implementer/reviewer pair from repository config
- **AND** it SHALL NOT say both Claude and Codex CLIs are required as the product

---

### Requirement: Supervisor docs SHALL link the packaging contract

`docs/supervisor.md` SHALL contain a working relative link to `docs/packaging.md`. It SHALL retain a sentence that merge is operator-authorized and that this repository does not ship a grant factory, MessagingPort, or second durable control plane.

#### Scenario: Supervisor page links packaging

- **WHEN** a reader opens `docs/supervisor.md`
- **THEN** the document SHALL contain a relative link to `docs/packaging.md`
- **AND** it SHALL state that merge is operator-authorized with no grant factory or second control plane
