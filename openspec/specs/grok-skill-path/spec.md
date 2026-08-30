# grok-skill-path Specification

## Purpose
TBD - created by archiving change install-document-grok-skill-path. Update Purpose after archive.
## Requirements
### Requirement: Supported Grok skill layout SHALL be documented for operators

The project SHALL document a supported layout for Grok Build consumers of the pipeline skill in both `README.md` and `docs/packaging.md`. The repository SHALL contain a generated `hosts/grok/SKILL.md` one-pager that is byte-identical to `hosts/claude/SKILL.md`; it is a conformance output, not a separate install overlay or fork. The preferred installed layout SHALL remain a symlink from `~/.grok/skills/pipeline` to the Claude-managed skill install. Documentation MAY still describe a copy of that shared tree as an alternative and SHALL state its update trade-off. Documentation and manifest post-install prose SHALL distinguish the generated repository output from the unchanged `symlink-claude` install lifecycle.

#### Scenario: README describes symlink-first Grok layout

- **WHEN** an operator reads the README install-related section for Grok Build
- **THEN** the README SHALL show or describe `~/.grok/skills/pipeline` as a symlink to the Claude-managed skill install
- **AND** it MAY mention copy as a secondary alternative with the update trade-off
- **AND** it SHALL NOT instruct the operator to install a distinct Grok tree overlay
- **AND** `docs/packaging.md` SHALL preserve the same symlink-first lifecycle

#### Scenario: Documentation states Grok host status

- **WHEN** an operator reads the documented Grok layout
- **THEN** the text SHALL describe `hosts/grok/SKILL.md` as a generated, byte-identical repository output
- **AND** SHALL state that the installed Grok path continues to consume the shared Claude-managed bytes through `symlink-claude`
- **AND** SHALL NOT describe the generated repository file as an installer overlay input

#### Scenario: Reinstall guidance covers the Grok path

- **WHEN** an operator reinstalls or updates the Claude-hosted skill after having used the Grok layout
- **THEN** the documentation SHALL give steps to restore or refresh the Grok symlink path
- **AND** SHALL NOT require a new Grok tree-mode migration

---

### Requirement: Installer help SHALL acknowledge the Grok consumption path

Installer help SHALL acknowledge Grok Build consumers in `scripts/install.mjs`
user-facing host guidance (usage header comment and the error text for an
unknown or missing `--host`). At minimum, when Grok is not a first-class
`--host` value, help SHALL point operators to the documented Grok
symlink/copy layout rather than implying only Claude and Codex exist. When
stretch `--host grok` is implemented, help and error text SHALL list `grok`
among valid host values.

#### Scenario: Unknown host error does not erase Grok consumers

- **WHEN** an operator runs the installer with an unsupported `--host` value
  (or reads the usage header)
- **THEN** the message SHALL either list `grok` as a valid host (if
  implemented) or direct the operator to the documented Grok skill layout
  (symlink/copy) for Grok Build

#### Scenario: Header usage stays accurate to implemented hosts

- **WHEN** the installer usage header documents `--host` values
- **THEN** every host name listed SHALL be accepted by the installer
- **AND** if `grok` is not implemented as a host, the header SHALL NOT claim
  `--host grok` works

### Requirement: Doctor version checks SHALL remain correct through a skill-path symlink

Doctor version checks SHALL remain correct when the pipeline skill is invoked
through a path that is a symlink to a managed install tree (for example
`~/.grok/skills/pipeline` → `~/.claude/skills/pipeline`). `pipeline doctor`
SHALL evaluate `install:version-coherence` and `install:version-freshness`
against the same core install identity as when invoked via the real managed
path. A symlink entry path alone SHALL NOT cause a false version mismatch or
a false freshness failure when the target tree is coherent and current.

#### Scenario: Symlink to coherent Claude install — coherence passes

- **WHEN** `~/.grok/skills/pipeline` is a symlink to a managed Claude skill
  install whose `core/package.json` version matches the running `VERSION`
- **AND** `pipeline doctor` runs using that engine
- **THEN** the `install:version-coherence` check SHALL pass
- **AND** the detail SHALL reflect the same install version as the managed
  target tree

#### Scenario: Symlink does not invent a second install root for freshness

- **WHEN** the skill path used to launch the engine is a symlink into a
  managed install
- **AND** `pipeline doctor` runs `install:version-freshness`
- **THEN** the check SHALL compare the running engine version (from that
  resolved install) to the latest upstream release using the existing freshness
  rules
- **AND** SHALL NOT fail solely because the process was started via a Grok
  symlink path

### Requirement: Optional installer host grok SHALL materialize the Grok skill path

Optional installer host `grok` SHALL keep materializing the Grok skill path through the existing `symlink-claude` mode: `install` and `update` with `--host grok` SHALL create or refresh `~/.grok/skills/pipeline` as a symlink to the Claude-managed skill directory when that Claude install exists. The generated `hosts/grok/SKILL.md` SHALL be byte-identical to the generated Claude SKILL, so the symlink exposes the same one-pager without a distinct Grok overlay. Refreshing an existing path SHALL only replace an existing symlink. A user-owned non-symlink path SHALL be preserved with remediation. A missing Claude-managed skill directory SHALL fail with remediation rather than silently creating a divergent copy. `grok` SHALL remain in valid-host usage and error lists.

#### Scenario: --host grok with Claude install present creates symlink

- **WHEN** a Claude-managed skill install exists
- **AND** the operator runs `node scripts/install.mjs install --host grok`
- **THEN** `~/.grok/skills/pipeline` SHALL exist as a symlink to that Claude-managed skill directory
- **AND** the SKILL bytes visible through the symlink SHALL match generated `hosts/grok/SKILL.md`

#### Scenario: --host grok without Claude install fails with remediation

- **WHEN** no Claude-managed skill install is present
- **AND** the operator runs install with `--host grok`
- **THEN** the installer SHALL exit non-zero
- **AND** the remediation SHALL instruct the operator to install the Claude host or documented shared staging path

#### Scenario: --host grok preserves existing non-symlink skill path

- **WHEN** `~/.grok/skills/pipeline` exists as a directory or other non-symlink path
- **AND** the operator runs install with `--host grok`
- **THEN** the installer SHALL NOT recursively delete that path
- **AND** SHALL exit non-zero with relocation or removal remediation

#### Scenario: --host grok refreshes an existing symlink without deleting trees

- **WHEN** `~/.grok/skills/pipeline` exists as a symlink whose target is not the current Claude skill directory
- **AND** the operator runs install with `--host grok` with Claude present
- **THEN** the installer SHALL replace only the symlink
- **AND** SHALL NOT recursively delete any directory tree at that path

#### Scenario: No Grok SKILL.md fork required

- **WHEN** `--host grok` is implemented
- **THEN** the repository SHALL keep `hosts/grok/SKILL.md` only as a generated byte-identical conformance output
- **AND** the installer SHALL NOT consume it as a distinct Grok overlay
- **AND** Grok SHALL continue to consume the shared Claude-managed skill content through the materialized symlink

#### Scenario: Grok manifest preserves the existing lifecycle

- **WHEN** the Grok repository conformance file is added
- **THEN** the Grok outer-host manifest SHALL remain `mode: "symlink-claude"`
- **AND** its `overlayDir` SHALL remain `hosts/claude`
- **AND** its `overlayFiles` SHALL remain `[]`
- **AND** install tests SHALL continue to cover symlink creation, refresh, missing-Claude remediation, and user-owned non-symlink preservation

#### Scenario: Valid host lists include grok when implemented

- **WHEN** `--host grok` is implemented
- **AND** an operator passes an unknown host or reads usage
- **THEN** `grok` SHALL appear alongside `claude`, `codex`, and `all` in the documented valid host set

