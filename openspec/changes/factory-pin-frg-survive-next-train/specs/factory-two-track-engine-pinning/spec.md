## ADDED Requirements

### Requirement: Factory ship promote and the next train doctor SHALL share one exported pin path

Factory ship composers (Tugboat and the host `pipeline` launcher) SHALL export
`AGENT_PIPELINE_PRODUCTION_PIN` when the operator has not set it. The default value SHALL
be the factory pin file: the factory control checkout
`.agent-pipeline/production-engine-pin.json` (absolute path). `pipeline engine-promote`
and the next `pipeline train` / `pipeline doctor` on that factory control plane SHALL
resolve the production pin through that same exported path.

A non-skip promote of version `X.Y.Z` SHALL write a production-quality pin (`frg_run_id`
does not start with `no-frg-`; `frg_evidence_path` is non-null) to that exported path.
The promote path SHALL NOT treat a worktree-local
`<repoDir>/.agent-pipeline/production-engine-pin.json` as factory pin authority when the
export is set (or when factory ship has applied the default export). Ordinary non-factory
product repositories SHALL NOT gain a new required pin from this export.

After that promote, `pipeline doctor` on the factory control checkout using the same pin
path SHALL accept the production-quality `frg-…` pin for `X.Y.Z` under pinned-track
intent (when install matches under existing track-coherence rules). Version `X.Y.Z+1`
train SHALL NOT require a manual copy of the pin file.

#### Scenario: Tugboat exports the factory pin when unset

- **WHEN** Tugboat starts a factory ship and `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **THEN** Tugboat SHALL export `AGENT_PIPELINE_PRODUCTION_PIN` to the factory control
  checkout `.agent-pipeline/production-engine-pin.json`
- **AND** subsequent `engine-promote` and doctor in that ship SHALL use that path

#### Scenario: Host pipeline launcher exports the factory pin when unset

- **WHEN** the host `pipeline` launcher runs on the factory control plane
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **THEN** the launcher SHALL export `AGENT_PIPELINE_PRODUCTION_PIN` to the factory pin
  file
- **AND** `engine-promote` and the next `pipeline train` doctor SHALL read and write
  that same path

#### Scenario: Promote writes the exported path not a worktree pin

- **WHEN** a non-skip `pipeline engine-promote --for 1.39.3` runs with
  `AGENT_PIPELINE_PRODUCTION_PIN` set to the factory pin file
- **AND** promote `repoDir` is a worktree that is not that factory pin directory
- **THEN** the written production-quality pin SHALL be at the exported factory pin path
- **AND** SHALL NOT leave the factory pin unchanged while only updating the worktree
  pin

#### Scenario: Next train doctor reads the same path after promote

- **WHEN** a non-skip promote of `1.39.3` has written `frg_run_id` `frg-abc` to the
  exported factory pin
- **AND** `pipeline doctor` runs on the factory control checkout with the same
  `AGENT_PIPELINE_PRODUCTION_PIN`
- **THEN** doctor SHALL load that factory pin
- **AND** SHALL NOT fail `install:engine-track` solely because a worktree still has
  `no-frg-1.39.1` or a stale committed `origin/main` pin that is not the exported path

#### Scenario: Operator override is preserved

- **WHEN** the operator has already set `AGENT_PIPELINE_PRODUCTION_PIN` to an explicit
  absolute pin path
- **THEN** Tugboat and the host launcher SHALL NOT overwrite that value
- **AND** promote and doctor SHALL continue to use the operator path

#### Scenario: Non-factory product repo does not require the export

- **WHEN** an ordinary advance runs against a non-factory product repository
- **AND** no factory ship composer or factory launcher export applies
- **THEN** the advance path SHALL NOT refuse for a missing
  `AGENT_PIPELINE_PRODUCTION_PIN` export
- **AND** existing pin-authority refuse rules SHALL still apply under explicit pinned
  intent
