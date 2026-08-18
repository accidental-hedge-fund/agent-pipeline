## ADDED Requirements

### Requirement: Non-skip engine-promote SHALL write the exported factory pin

When `AGENT_PIPELINE_PRODUCTION_PIN` is set (including when factory ship exported the
default factory pin file), a successful non-skip `pipeline engine-promote` SHALL write
the production-quality pin to that path. The command SHALL NOT update only
`<repoDir>/.agent-pipeline/production-engine-pin.json` when `repoDir` is a worktree (or
other directory) that is not the exported pin's directory.

Default promote (no resolved skip) SHALL NOT write `frg_run_id` `no-frg-<X.Y.Z>` or a
null `frg_evidence_path`. A unit test SHALL fail if that default write is reintroduced.

#### Scenario: Promote with exported pin path updates that file

- **WHEN** `AGENT_PIPELINE_PRODUCTION_PIN` is `/factory/.agent-pipeline/production-engine-pin.json`
- **AND** promote `repoDir` is `/worktrees/pipeline-promote`
- **AND** non-skip `pipeline engine-promote --for 1.39.3` succeeds from FRG evidence
  with `run_id` `frg-abc` and `pass: true`
- **THEN** `/factory/.agent-pipeline/production-engine-pin.json` SHALL contain
  `version` `1.39.3` and `frg_run_id` `frg-abc`
- **AND** SHALL contain a non-null `frg_evidence_path`
- **AND** SHALL NOT set `frg_run_id` to `no-frg-1.39.3`

#### Scenario: Default promote test fails on no-frg write

- **WHEN** unit tests invoke non-skip promote with injected FRG lookup returning a
  real pass
- **THEN** the written pin SHALL NOT have `frg_run_id` starting with `no-frg-`
- **AND** the same suite SHALL fail if default promote writes `no-frg-<version>`
  without explicit skip
- **AND** no real network, git, or subprocess call SHALL occur
