# cross-host-profiles Specification

## Purpose
The host seam that lets one shared core ship as both `/pipeline` (Claude Code) and `$pipeline` (Codex): a JSON profile per host that fixes the harness roles, the review mode, and host-specific presentation defaults. Roles are harness-relative — the invoking host is always the implementer; the other harness reviews.
## Requirements
### Requirement: Profiles are named JSON files loaded by name

Profiles SHALL live at `core/profiles/<name>.json` and be loaded by `loadProfile(name)`. The repo ships exactly two profiles: `claude` and `codex`. Each profile SHALL define `name`, `displayName`, `invocation`, `harnesses` (`implementer` + `reviewer`), `reviewMode`, and host presentation defaults (`markerFooter`, `implementationReadyMessage`, `conventionsDefault`). The `conventionsDefault` field SHALL identify the filename the implementing and fix harness prompts instruct the editing harness to read (e.g. `CLAUDE.md` for the `claude` profile, `AGENTS.md` for the `codex` profile); prompt text that references the conventions file SHALL name both values or use a host-neutral phrase rather than hardcoding one filename.

#### Scenario: load a profile

- **WHEN** `loadProfile("claude")` is called
- **THEN** it SHALL return the parsed `core/profiles/claude.json` with `name: "claude"`, `invocation: "/pipeline"`, and `harnesses: { implementer: "claude", reviewer: "codex" }`

#### Scenario: unknown profile rejected

- **WHEN** a profile name with no matching file is requested (including `"openclaw"`)
- **THEN** `loadProfile` SHALL throw rather than silently default

#### Scenario: implementing prompt names the correct conventions file

- **WHEN** the implementing prompt is built under the `codex` profile
- **THEN** any instruction in the prompt referencing the conventions file SHALL be accurate for `AGENTS.md` and SHALL NOT reference only `CLAUDE.md`

#### Scenario: SKILL.md per-repo-config example uses the host-appropriate conventions filename

- **WHEN** `hosts/codex/SKILL.md` shows a per-repo-config example involving the conventions file
- **THEN** the example SHALL reference `AGENTS.md` (or omit the filename) rather than `CLAUDE.md`

### Requirement: Harness roles are harness-relative
Each profile SHALL assign `implementer` and `reviewer` so the invoking host implements and the other harness reviews. `claude` → implementer `claude` / reviewer `codex`; `codex` → implementer `codex` / reviewer `claude`.

#### Scenario: Claude-invoked run
- **WHEN** the run uses the `claude` profile
- **THEN** planning/implementation/fix SHALL run on `claude` and review SHALL run on `codex`

#### Scenario: Codex-invoked run
- **WHEN** the run uses the `codex` profile
- **THEN** planning/implementation/fix SHALL run on `codex` and review SHALL run on `claude`

### Requirement: reviewMode defaults to prompt-harness
Every shipped profile SHALL set `reviewMode: "prompt-harness"` — review invokes the reviewer harness CLI directly with the pipeline's own JSON-returning review prompt, requiring no companion plugin. The companion modes (`claude-companion`, `codex-companion`) are no longer valid `reviewMode` values and SHALL NOT be accepted.

#### Scenario: default review mode
- **WHEN** either `claude` or `codex` is loaded
- **THEN** its `reviewMode` SHALL be `"prompt-harness"`

### Requirement: The profile, not file config, selects the per-role harness
At stage execution, the implementer-role harness (`harnesses.implementer`) SHALL run planning/implementation/fix and the reviewer-role harness (`harnesses.reviewer`) SHALL run review, dispatched by `invoke(...)`. The implementer harness SHALL come from the profile and SHALL NOT be overridable by `.github/pipeline.yml`. The reviewer harness SHALL default to the profile's value but MAY be overridden at config-resolve time by the `review_harness` key in `.github/pipeline.yml` (see `pipeline-configuration` and `configurable-review-harness`).

#### Scenario: role drives CLI invocation with no override
- **WHEN** planning runs under the `claude` profile and no `review_harness` key is set
- **THEN** the implementer CLI invoked SHALL be `claude`
- **AND** the subsequent review SHALL invoke the `codex` CLI

#### Scenario: reviewer overridden by repo config
- **WHEN** the `claude` profile is active and `.github/pipeline.yml` sets `review_harness: custom-reviewer`
- **THEN** the implementer CLI SHALL be `claude`
- **AND** review SHALL invoke `custom-reviewer` rather than the profile's default `codex`

### Requirement: Default profile is codex
When no profile is specified (neither an explicit option nor `PIPELINE_PROFILE`), `resolveConfig()` SHALL load the `codex` profile.

#### Scenario: no profile specified
- **WHEN** `resolveConfig()` runs with no profile option and `PIPELINE_PROFILE` unset
- **THEN** the `codex` profile SHALL be loaded

