## ADDED Requirements

### Requirement: The codex harness invoke SHALL pass a configured model via a `-m` flag

`invoke()` SHALL, when `harness === "codex"` and `opts.model` is set, append `-m <value>` to the codex CLI arguments. When `opts.model` is absent, `invoke()` SHALL NOT add any `-m` flag. This model passthrough is independent of and composes with the existing effort passthrough (`-c model_reasoning_effort=<value>`). The claude path (`--model <value>`) and custom-reviewer-CLI path SHALL be unchanged by this requirement.

#### Scenario: codex invoke with a model

- **WHEN** `invoke("codex", dir, prompt, { model: "gpt-5.6-terra" })` is called
- **THEN** the codex process arguments SHALL include `-m gpt-5.6-terra`

#### Scenario: codex invoke without a model

- **WHEN** `invoke("codex", dir, prompt, {})` is called with no `model`
- **THEN** the codex process arguments SHALL NOT include any `-m` flag

#### Scenario: codex invoke composes model and effort

- **WHEN** `invoke("codex", dir, prompt, { model: "gpt-5.6-terra", reasoningEffort: "high" })` is called
- **THEN** the codex process arguments SHALL include both `-m gpt-5.6-terra` and `-c model_reasoning_effort=high`

### Requirement: Auto model resolution for a codex reviewer SHALL NOT emit a claude-only alias

When the effective reviewer command is `codex` and a reviewer model is produced by expanding the `"auto"` sentinel, the resolution SHALL NOT hand a claude-only alias to the codex invocation. Because every Adversarial routing cell (`plan-review`, `review-1`, `review-2`) resolves `auto` to `claude-fable-5` — a claude-only alias with no codex equivalent in the routing matrix — the resolution SHALL omit the model (no `-m` flag; codex uses its configured default) rather than forward the claude-only alias. This requirement governs only the `auto` case for a codex reviewer; an explicit (non-`auto`) reviewer model is forwarded verbatim.

#### Scenario: codex reviewer + auto omits the model flag

- **WHEN** the effective reviewer command is `codex` and `models.review` (or `review_harness.model`) is `"auto"`
- **THEN** the reviewer model handed to the codex invocation SHALL be omitted (no `-m` flag)
- **AND** the value `claude-fable-5` SHALL NOT be passed to codex

#### Scenario: claude reviewer + auto still resolves the fable id

- **WHEN** the effective reviewer command is `claude` and `models.review` (or `review_harness.model`) is `"auto"`
- **THEN** the reviewer model handed to the claude invocation SHALL be `"claude-fable-5"` (round-aware, unchanged)
