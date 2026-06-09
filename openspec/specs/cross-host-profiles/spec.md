# cross-host-profiles Specification

## Purpose
The host seam that lets one shared core ship as both `/pipeline` (Claude Code) and `$pipeline` (Codex): a JSON profile per host that fixes the harness roles, the review mode, and host-specific presentation defaults. Roles are harness-relative — the invoking host is always the implementer; the other harness reviews.

## Requirements

### Requirement: Profiles are named JSON files loaded by name
Profiles SHALL live at `core/profiles/<name>.json` and be loaded by `loadProfile(name)`. The repo ships `claude`, `codex`, and `openclaw`. Each profile SHALL define `name`, `displayName`, `invocation`, `harnesses` (`implementer` + `reviewer`), `reviewMode`, and host presentation defaults (`markerFooter`, `implementationReadyMessage`, `conventionsDefault`).

#### Scenario: load a profile
- **WHEN** `loadProfile("claude")` is called
- **THEN** it SHALL return the parsed `core/profiles/claude.json` with `name: "claude"`, `invocation: "/pipeline"`, and `harnesses: { implementer: "claude", reviewer: "codex" }`

#### Scenario: unknown profile rejected
- **WHEN** a profile name with no matching file is requested
- **THEN** `loadProfile` SHALL throw rather than silently default

### Requirement: Harness roles are harness-relative
Each profile SHALL assign `implementer` and `reviewer` so the invoking host implements and the other harness reviews. `claude` → implementer `claude` / reviewer `codex`; `codex` → implementer `codex` / reviewer `claude`; `openclaw` → implementer `claude` / reviewer `codex`.

#### Scenario: Claude-invoked run
- **WHEN** the run uses the `claude` profile
- **THEN** planning/implementation/fix SHALL run on `claude` and review SHALL run on `codex`

#### Scenario: Codex-invoked run
- **WHEN** the run uses the `codex` profile
- **THEN** planning/implementation/fix SHALL run on `codex` and review SHALL run on `claude`

### Requirement: reviewMode defaults to prompt-harness
Every shipped profile SHALL set `reviewMode: "prompt-harness"` — review invokes the reviewer harness CLI directly with the pipeline's own JSON-returning review prompt, requiring no companion plugin. The companion modes (`claude-companion`, `codex-companion`) remain valid optional values but are not the default. (The review flow itself is refined by the `review-sha-gating` and `verdict-normalization` delta specs.)

#### Scenario: default review mode
- **WHEN** any of `claude`, `codex`, or `openclaw` is loaded
- **THEN** its `reviewMode` SHALL be `"prompt-harness"`

### Requirement: The profile, not file config, selects the per-role harness
At stage execution, the implementer-role harness (`harnesses.implementer`) SHALL run planning/implementation/fix and the reviewer-role harness (`harnesses.reviewer`) SHALL run review, dispatched by `invoke(...)`. These come from the profile and cannot be overridden by `.github/pipeline.yml` (see `pipeline-configuration`).

#### Scenario: role drives CLI invocation
- **WHEN** planning runs under the `claude` profile
- **THEN** the implementer CLI invoked SHALL be `claude`
- **AND** the subsequent review SHALL invoke the `codex` CLI

### Requirement: Default profile is codex
When no profile is specified (neither an explicit option nor `PIPELINE_PROFILE`), `resolveConfig()` SHALL load the `codex` profile.

#### Scenario: no profile specified
- **WHEN** `resolveConfig()` runs with no profile option and `PIPELINE_PROFILE` unset
- **THEN** the `codex` profile SHALL be loaded
