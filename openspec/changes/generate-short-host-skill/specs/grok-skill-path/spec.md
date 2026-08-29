## MODIFIED Requirements

### Requirement: Supported Grok skill layout SHALL be documented for operators

The project SHALL document a supported layout for Grok Build consumers of the pipeline skill. The documented layout SHALL include a generated `hosts/grok/SKILL.md` one-pager (verb table plus follow/notify contract) materialized at the Grok skill path. Documentation MAY still describe a CLI-tree symlink or shared install for the engine, but it SHALL NOT claim that Grok has no SKILL overlay or that Grok must consume the Claude SKILL essay.

#### Scenario: README describes symlink-first Grok layout

- **WHEN** an operator reads the README install-related section for Grok Build
- **THEN** the README SHALL describe installing or refreshing the Grok skill path
- **AND** SHALL NOT tell the operator that Grok has no `hosts/grok/SKILL.md`

#### Scenario: Documentation states Grok host status

- **WHEN** an operator reads the documented Grok layout
- **THEN** the text SHALL describe Grok as a first-class SKILL host that receives the generated short SKILL
- **AND** SHALL NOT claim a required Claude-essay fork as the Grok skill body

#### Scenario: Reinstall guidance covers the Grok path

- **WHEN** an operator reinstalls or updates after having used the Grok layout
- **THEN** the documentation SHALL give steps to restore or refresh the Grok skill path
- **AND** SHALL include publishing the generated Grok SKILL overlay

---

### Requirement: Optional installer host grok SHALL materialize the Grok skill path

Optional installer host `grok` SHALL materialize the Grok skill path when implemented: `install` and `update` with `--host grok` SHALL create or refresh `~/.grok/skills/pipeline` and SHALL publish the generated `hosts/grok/SKILL.md` overlay onto that path. Refreshing an existing path SHALL not recursively delete a user-owned non-symlink directory without remediation. If the engine tree is missing, the installer SHALL fail with remediation rather than silently creating a divergent copy without guidance. `grok` SHALL appear in valid-host usage and error lists when this host is implemented.

#### Scenario: --host grok with Claude install present creates symlink

- **WHEN** a managed engine install exists
- **AND** the operator runs `node scripts/install.mjs install --host grok`
- **THEN** `~/.grok/skills/pipeline` SHALL exist
- **AND** that path SHALL contain the generated Grok SKILL overlay

#### Scenario: --host grok without Claude install fails with remediation

- **WHEN** no managed engine install is present
- **AND** the operator runs install with `--host grok`
- **THEN** the installer SHALL exit non-zero
- **AND** the error or remediation SHALL instruct the operator to install the engine before or with Grok path setup

#### Scenario: --host grok preserves existing non-symlink skill path

- **WHEN** `~/.grok/skills/pipeline` exists as a directory or other path that the installer is not allowed to replace
- **AND** the operator runs install with `--host grok`
- **THEN** the installer SHALL NOT recursively delete that path without remediation
- **AND** SHALL exit non-zero when it cannot overlay the generated SKILL safely

#### Scenario: --host grok refreshes an existing symlink without deleting trees

- **WHEN** `~/.grok/skills/pipeline` exists as a symlink whose target is not the current engine skill directory
- **AND** the operator runs install with `--host grok` with the engine present
- **THEN** the installer SHALL publish the generated Grok SKILL overlay onto the Grok skill path
- **AND** SHALL NOT recursively delete a user-owned tree without remediation

#### Scenario: No Grok SKILL.md fork required

- **WHEN** `--host grok` is implemented
- **THEN** the repository SHALL keep `hosts/grok/SKILL.md` as a generated short SKILL from the shared one-pager
- **AND** Grok SHALL consume that overlay rather than a handwritten Claude essay

#### Scenario: Valid host lists include grok when implemented

- **WHEN** `--host grok` is implemented
- **AND** an operator passes an unknown host or reads usage
- **THEN** `grok` SHALL appear alongside `claude`, `codex`, and `all` in the documented valid host set
