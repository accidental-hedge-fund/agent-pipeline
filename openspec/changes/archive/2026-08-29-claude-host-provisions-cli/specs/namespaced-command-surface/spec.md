## REMOVED Requirements

### Requirement: Each in-scope operation SHALL be exposed as a distinct `pipeline:<command>` host entry

**Reason:** v1.40.0 packaging law (#1046 / #1048): the product is the `pipeline` CLI. Slash-command files are not required and must not ship. `OPERATION_SURFACE` is a catalog, not a reason to emit one markdown file per verb.

**Migration:** Operators invoke `pipeline <verb>` (for example `pipeline status 42`). The host SKILL tells the agent to exec that CLI. Uninstall still removes leftover `pipeline:*.md`. See `cli-host-provision`.

### Requirement: The host command set SHALL be symmetric across Claude and Codex

**Reason:** Symmetry of generated `/pipeline:<command>` and `$pipeline:<command>` files is withdrawn. Both hosts exec the same CLI.

**Migration:** Keep one CLI keyword surface and one `OPERATION_SURFACE` catalog. Do not generate per-host command files to stay in sync.

### Requirement: Each `pipeline:<command>` entry SHALL forward to the equivalent CLI invocation

**Reason:** There is no per-verb host command entry to forward.

**Migration:** Invoke the CLI keyword directly. Mapping examples stay as CLI: `pipeline status <N>`, `pipeline doctor`, `pipeline recover-parked <N>`.

### Requirement: The migrated documentation SHALL reflect the new invocation shapes

**Reason:** Docs that present `/pipeline:<command>` / `$pipeline:<command>` as the product path contradict CLI-as-product.

**Migration:** Document `pipeline <verb>`. Host SKILL invocation tokens may remain as the way to load the SKILL, not as a per-verb command pack. Short SKILL tables are #1049.

### Requirement: `renderClaudeCommand` SHALL produce YAML frontmatter that is syntactically valid

**Reason:** Claude command files are not generated.

**Migration:** Delete or stop calling the per-verb Claude command renderer. YAML frontmatter for `pipeline:<verb>.md` is not a product contract.

### Requirement: `renderCodexCommand` SHALL produce YAML agent files suitable for Codex host discovery

**Reason:** Codex yaml command agents from `OPERATION_SURFACE` are not generated.

**Migration:** Codex install provisions the CLI plus SKILL. Do not write `pipeline-<name>.yaml` agents from the catalog.

### Requirement: Host command entries SHALL be documented as CLI shims, not the product surface

**Reason:** This #1047 bridge requirement explicitly allowed generated per-verb host command files to remain. #1048 retires those files and makes direct `pipeline <verb>` execution from the host SKILL the durable contract.

**Migration:** Use the added “Hosts SHALL invoke CLI verbs rather than a generated command pack” requirement.

## ADDED Requirements

### Requirement: Hosts SHALL invoke CLI verbs rather than a generated command pack

Claude, Codex, and Grok SHALL expose in-scope operations by exec of `pipeline <verb>` from the host SKILL. The in-scope operation set SHALL remain the CLI keywords (including `status`, `unblock`, `override`, `summary`, `doctor`, `init`, `cleanup`, `intake`, `sweep`, `triage`, `merge`, `merge-queue`, `release`, `roadmap`, `logs`, `loop`, `recover-parked`). Hosts SHALL NOT require a generated `pipeline:<command>` file per verb. Adding a verb to `OPERATION_SURFACE` SHALL update the catalog. It SHALL NOT emit a host command file.

#### Scenario: Status is a CLI verb not a slash file

- **WHEN** an operator wants issue 42 status
- **THEN** the product invocation SHALL be `pipeline status 42`
- **AND** a `pipeline:status.md` host command file SHALL NOT be required

#### Scenario: Catalog change does not emit command files

- **WHEN** a verb is present in `OPERATION_SURFACE` and `scripts/build.mjs` is run
- **THEN** the generator SHALL NOT write `pipeline:<verb>.md` or Codex `pipeline-<verb>.yaml` command agents

## MODIFIED Requirements

### Requirement: The `loop` operation SHALL use long-running packaging, not the shared fast template

Host SKILL guidance for multi-item drive and resume of `pipeline loop` SHALL treat the
operation as long-running. Host skill guidance for drive and resume SHALL NOT claim
that the command “completes in seconds” and SHALL NOT instruct harnesses that “no
background process or Monitor is needed.” Read-only `--audit` MAY remain documented
as a short synchronous mode. This requirement SHALL NOT depend on a generated
`pipeline:loop.md` command file.

#### Scenario: Loop is not rendered with the fast template

- **WHEN** the Claude or Codex host SKILL describes `pipeline loop` drive or resume
- **THEN** that guidance SHALL NOT contain the substring “completes in seconds”
  (case-insensitive)
- **AND** SHALL NOT contain the substring “No background process or Monitor needed”
  (case-insensitive)
- **AND** `scripts/build.mjs` SHALL NOT write `plugin/pipeline/commands/pipeline:loop.md`

#### Scenario: True-fast peers still use the fast template

- **WHEN** host SKILL or CLI docs describe a true-fast operation such as `status` or `doctor`
- **THEN** they MAY still note that those CLI verbs complete in seconds
- **AND** the generator SHALL NOT emit a `pipeline:status.md` or `pipeline:doctor.md` command file to carry that note

#### Scenario: Audit mode stays synchronous

- **WHEN** host or CLI docs describe `pipeline loop --audit`
- **THEN** they MAY document that mode as read-only and seconds-long
- **AND** they SHALL NOT use that audit guidance as the orchestration rule for
  drive or resume

### Requirement: The merge-queue host entry SHALL document dry-run default and human authority

The `pipeline merge-queue` CLI and host SKILL description SHALL state that the command
plans an ordered ready-to-deploy merge queue under explicit operator invocation,
defaults to dry-run, and is never called by the advance loop. It SHALL NOT
describe autonomous or background merging. This requirement SHALL NOT depend on a
generated `pipeline:merge-queue.md` command file.

#### Scenario: Host one-liner states dry-run and non-advance

- **WHEN** the CLI or host SKILL description for `pipeline merge-queue` is inspected
- **THEN** it SHALL mention dry-run (or default non-mutating plan) behavior
- **AND** SHALL NOT claim the advance loop merges via this command

### Requirement: Host recover-parked entry SHALL only forward to the CLI

Host SKILL packaging for recover-parked SHALL document invocation of the engine CLI
`pipeline recover-parked` (and any Tugboat/Hermes skill text that documents the
operation), or no-op + STOP when the host chooses not to invoke it. Host packaging
and skill prose SHALL NOT instruct inventing `pipeline override` dispositions,
dropping `blocked`/`needs-human` labels, or reclassifying structured
HIGH/CRITICAL/security findings outside the CLI. This requirement SHALL NOT depend
on a generated `pipeline:recover-parked.md` command file.

#### Scenario: Host entry documents CLI-only reflow

- **WHEN** an operator reads the host SKILL recover-parked guidance
- **THEN** the documented action SHALL be invocation of `pipeline recover-parked`
- **AND** it SHALL NOT document a host-local override or label-drop alternative for the same reflow

#### Scenario: Host skill must not invent override for parked residuals

- **WHEN** a thin host observes `needs-human` or leftover `blocked` after deterministic resume
- **THEN** the host contract SHALL allow calling `pipeline recover-parked` once or STOP
- **AND** SHALL forbid host-improvised `pipeline override` or silent removal of `blocked` for that reflow
