## MODIFIED Requirements

### Requirement: Profiles are named JSON files loaded by name
Profiles SHALL live at `core/profiles/<name>.json` and be loaded by `loadProfile(name)`. The repo ships exactly two profiles: `claude` and `codex`. Each profile SHALL define `name`, `displayName`, `invocation`, `harnesses` (`implementer` + `reviewer`), `reviewMode`, and host presentation defaults (`markerFooter`, `implementationReadyMessage`, `conventionsDefault`).

#### Scenario: load a profile
- **WHEN** `loadProfile("claude")` is called
- **THEN** it SHALL return the parsed `core/profiles/claude.json` with `name: "claude"`, `invocation: "/pipeline"`, and `harnesses: { implementer: "claude", reviewer: "codex" }`

#### Scenario: unknown profile rejected
- **WHEN** a profile name with no matching file is requested (including `"openclaw"`)
- **THEN** `loadProfile` SHALL throw rather than silently default

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
