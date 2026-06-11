## MODIFIED Requirements

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
