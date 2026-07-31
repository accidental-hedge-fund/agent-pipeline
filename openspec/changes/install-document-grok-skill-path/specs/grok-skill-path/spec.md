## ADDED Requirements

### Requirement: Supported Grok skill layout SHALL be documented for operators

The project SHALL document a supported layout for Grok Build consumers of the
pipeline skill. The preferred layout SHALL be a symlink from
`~/.grok/skills/pipeline` to the Claude-managed skill install (default
`~/.claude/skills/pipeline`, or the equivalent under `CLAUDE_CONFIG_DIR`). The
documentation SHALL also allow a copy of the skill tree under
`~/.grok/skills/pipeline` as an acceptable alternative and SHALL state the
trade-off that a copy does not automatically track Claude-side updates. The
documentation SHALL state that Grok is not a first-class host overlay (no
required `hosts/grok` SKILL.md fork) unless and until an installer
`--host grok` target is shipped, in which case documentation SHALL describe
that target without introducing a Grok-only SKILL.md fork.

#### Scenario: README describes symlink-first Grok layout

- **WHEN** an operator reads the README install-related section for Grok Build
- **THEN** the README SHALL show or describe creating
  `~/.grok/skills/pipeline` as a symlink to the Claude skill install path
- **AND** SHALL mention copy as a secondary alternative with the update
  trade-off

#### Scenario: Documentation states Grok host status

- **WHEN** an operator reads the documented Grok layout
- **THEN** the text SHALL state that Grok is not a first-class host overlay
  with its own `hosts/grok` packaging, or — if `--host grok` is documented —
  SHALL describe that target as path materialization (symlink/staging) without
  claiming a separate Grok SKILL.md fork

#### Scenario: Reinstall guidance covers the Grok path

- **WHEN** an operator reinstalls or updates the Claude-hosted skill after
  having used the Grok layout
- **THEN** the documentation SHALL give steps to restore or refresh the Grok
  skill path (re-create the symlink, re-run a documented Grok install command,
  or equivalent) without requiring the operator to invent paths from source

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

Optional installer host `grok` SHALL materialize the Grok skill path when
implemented: `install` and `update` with `--host grok` SHALL create or refresh
`~/.grok/skills/pipeline` as a symlink to the Claude-managed skill directory
when that Claude install exists. The installer SHALL NOT introduce a separate
`hosts/grok` SKILL.md fork for this behavior. If the Claude-managed skill
directory is missing, the installer SHALL fail with remediation that names
installing Claude (or the documented shared staging alternative) rather than
silently creating a divergent copy without guidance. `grok` SHALL appear in
valid-host usage and error lists when this host is implemented.

#### Scenario: --host grok with Claude install present creates symlink

- **WHEN** `~/.claude/skills/pipeline` (or the `CLAUDE_CONFIG_DIR` equivalent)
  exists as a managed install
- **AND** the operator runs `node scripts/install.mjs install --host grok`
  (or the equivalent `npx … install --host grok`)
- **THEN** `~/.grok/skills/pipeline` SHALL exist as a symlink whose target is
  that Claude skill directory

#### Scenario: --host grok without Claude install fails with remediation

- **WHEN** no Claude-managed skill install is present
- **AND** the operator runs install with `--host grok`
- **THEN** the installer SHALL exit non-zero
- **AND** the error or remediation SHALL instruct the operator to install the
  Claude host (or follow the documented shared-staging path) before or with
  Grok path setup

#### Scenario: No Grok SKILL.md fork required

- **WHEN** `--host grok` is implemented
- **THEN** the repository SHALL NOT require a `hosts/grok/SKILL.md` overlay
  solely to satisfy this host target
- **AND** Grok SHALL continue to consume the Claude (or shared) skill content
  via the materialized path

#### Scenario: Valid host lists include grok when implemented

- **WHEN** `--host grok` is implemented
- **AND** an operator passes an unknown host or reads usage
- **THEN** `grok` SHALL appear alongside `claude`, `codex`, and `all` in the
  documented valid host set
