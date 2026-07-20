# configurable-review-harness Specification

## Purpose
TBD - created by archiving change configurable-review-harness. Update Purpose after archive.
## Requirements
### Requirement: review_harness config key overrides the profile reviewer

`PartialConfigSchema` SHALL accept an optional `review_harness` key that is either a bare `string` (the command shorthand) or a strict object `{ command: string, model?: string | "auto", effort?: string | "auto" }`. When present in either form, `resolveConfig()` SHALL use the command as `cfg.harnesses.reviewer` in place of the profile's default reviewer harness, applied after the profile/file/CLI merge step. For the object form, `resolveConfig()` SHALL additionally set `cfg.harnesses.reviewerModel` from `model` and `cfg.harnesses.reviewerEffort` from `effort`; for the string form, both SHALL remain unset. The `harnesses:` block SHALL remain absent from `PartialConfigSchema` and SHALL continue to be rejected by strict validation. When `review_harness` is absent, the profile's reviewer is used unchanged and `reviewerModel`/`reviewerEffort` are unset.

#### Scenario: review_harness string form present

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer`
- **THEN** `resolveConfig()` SHALL set `cfg.harnesses.reviewer` to `"my-reviewer"` regardless of the profile's default reviewer, and `cfg.harnesses.reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: review_harness object form present

- **WHEN** `.github/pipeline.yml` sets `review_harness: { command: claude, model: claude-fable-5, effort: max }`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"claude"`, `cfg.harnesses.reviewerModel` SHALL be `"claude-fable-5"`, and `cfg.harnesses.reviewerEffort` SHALL be `"max"`

#### Scenario: review_harness key absent

- **WHEN** `.github/pipeline.yml` does not include a `review_harness` key
- **THEN** `cfg.harnesses.reviewer` SHALL equal the profile's default reviewer harness with no warning or change in behavior, and `reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: review_harness key absent under claude profile

- **WHEN** the `claude` profile is active and `.github/pipeline.yml` has no `review_harness` key
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` (the profile's cross-harness default)

### Requirement: invoke() accepts an arbitrary string harness name
`invoke()` SHALL accept a `string` for the `harness` parameter. For `"claude"` and `"codex"`, the invocation shapes are unchanged. For any other string value, `invoke()` SHALL spawn the CLI named by the string with the prompt as a positional argument, capture its stdout as the harness output, and surface a specific failure message when the CLI cannot be spawned.

#### Scenario: built-in claude harness invocation unchanged
- **WHEN** `invoke("claude", ...)` is called
- **THEN** the `claude` CLI SHALL be invoked with `--print --permission-mode bypassPermissions --output-format text` flags, as before this change

#### Scenario: built-in codex harness invocation unchanged
- **WHEN** `invoke("codex", ...)` is called
- **THEN** the `codex` CLI SHALL be invoked with `exec --full-auto -C <worktreeDir>` flags, as before this change

#### Scenario: custom harness string is spawned with prompt as argument
- **WHEN** `invoke("my-reviewer", worktreeDir, prompt, opts)` is called
- **THEN** `my-reviewer` SHALL be spawned with the prompt as a positional argument and its stdout SHALL be returned as the harness output

### Requirement: Configured reviewer CLI unavailability fails with a specific, actionable message
When the configured reviewer CLI (from `cfg.harnesses.reviewer`) cannot be spawned — because it is not found on PATH, lacks execute permission, or exits immediately with a spawn error — `invoke()` SHALL surface an error message that names the CLI explicitly (e.g. `reviewer CLI 'my-reviewer' not found or not executable — ensure it is installed and on PATH`) rather than throwing `"Unknown harness"`. The `invokeReviewer` self-review fallback (established by #39) SHALL apply: the implementing harness is tried next; if it also fails, the item is blocked with an error naming both the configured reviewer and the fallback.

#### Scenario: configured reviewer not on PATH
- **WHEN** `cfg.harnesses.reviewer` names a CLI that is not installed
- **THEN** the error message surfaced SHALL name the CLI explicitly and SHALL NOT read only `"Unknown harness"`
- **AND** the `invokeReviewer` self-review fallback SHALL be attempted with the implementing harness

#### Scenario: both configured reviewer and self-review fallback fail
- **WHEN** the configured reviewer is not spawnable AND the implementing harness is also not spawnable
- **THEN** the item SHALL be blocked with an error message that names both the configured reviewer and the fallback harness

### Requirement: Reviewer model and effort SHALL resolve round-aware from reviewer overrides then config fallback

The review routing SHALL pass the reviewer model as `cfg.harnesses.reviewerModel ?? cfg.models.review` and the reviewer effort as `cfg.harnesses.reviewerEffort ?? cfg.effort.review` to each `invokeReviewer` call. When either resolved value is `"auto"`, it SHALL be resolved using the classification of the concrete review round: `review-1` as Adversarial/Iterative and `review-2` as Adversarial/Definitive. The plan-review round SHALL resolve `auto` as Adversarial/Definitive.

The resolved reviewer **model** SHALL be validated against the effective reviewer command before it reaches the harness invocation: when the reviewer command is `codex` and the resolved model is a claude-only alias (an alias the claude CLI recognizes but codex does not, e.g. `claude-fable-5`, `sonnet`, `opus`), the review routing SHALL pass no model to the invocation (so `codex exec` receives no `-m` flag and uses its configured default) rather than forwarding the claude-only alias. An explicit (non-`auto`) reviewer model SHALL be forwarded verbatim to the reviewer command regardless of harness.

#### Scenario: reviewer override wins over config fallback

- **WHEN** `review_harness: { command: claude, model: opus }` is set and `models.review` is `"sonnet"`
- **THEN** review routing SHALL pass model `"opus"` to `invokeReviewer` (the reviewer override wins)

#### Scenario: reviewer auto is round-aware

- **WHEN** `review_harness: { command: claude, model: auto, effort: auto }` is set
- **THEN** `review-1` SHALL resolve to model `"claude-fable-5"` / effort `"high"` (Iterative)
- **AND** `review-2` SHALL resolve to model `"claude-fable-5"` / effort `"max"` (Definitive)

#### Scenario: config fallback when reviewer overrides absent

- **WHEN** `review_harness: claude` (string form) is set and `effort: { review: high }` is configured
- **THEN** review routing SHALL pass effort `"high"` from `cfg.effort.review` (the config fallback)

#### Scenario: codex reviewer with auto model resolves to no model flag

- **WHEN** the effective reviewer command is `codex` and the resolved reviewer model comes from the `"auto"` sentinel (which yields the claude-only alias `claude-fable-5` for every Adversarial round)
- **THEN** review routing SHALL NOT forward a claude-only alias to codex
- **AND** the `codex exec` invocation SHALL omit the `-m` flag

#### Scenario: codex reviewer with an explicit model forwards it verbatim

- **WHEN** `review_harness: { command: codex, model: gpt-5.6-terra }` is set
- **THEN** review routing SHALL pass model `"gpt-5.6-terra"` to `invokeReviewer`
- **AND** the `codex exec` invocation SHALL include `-m gpt-5.6-terra`

### Requirement: The codex reviewer invocation SHALL honor a configured model via `-m`

`invoke()` SHALL, when `harness === "codex"` and `opts.model` is set, append `-m <opts.model>` to the `codex exec` arguments, placed before the trailing prompt positional. When `opts.model` is absent, `invoke()` SHALL NOT add any `-m` flag (codex uses its configured default). The existing effort passthrough (`-c model_reasoning_effort=<value>`) SHALL be unaffected, and the claude and custom-reviewer-CLI paths SHALL be unchanged by this requirement.

#### Scenario: codex invoke with a model

- **WHEN** `invoke("codex", dir, prompt, { model: "gpt-5.6-terra" })` is called
- **THEN** the codex process arguments SHALL include `-m gpt-5.6-terra`

#### Scenario: codex invoke with model and effort

- **WHEN** `invoke("codex", dir, prompt, { model: "gpt-5.6-terra", reasoningEffort: "high" })` is called
- **THEN** the codex process arguments SHALL include both `-m gpt-5.6-terra` and `-c model_reasoning_effort=high`

#### Scenario: codex invoke without a model omits the flag

- **WHEN** `invoke("codex", dir, prompt, { reasoningEffort: "high" })` is called with no `model`
- **THEN** the codex process arguments SHALL NOT include any `-m` flag
- **AND** SHALL still include `-c model_reasoning_effort=high`

#### Scenario: custom reviewer CLI receives neither flag

- **WHEN** `invoke("my-reviewer", dir, prompt, { model: "x", reasoningEffort: "high" })` is called
- **THEN** the custom CLI SHALL be spawned with the prompt as its only positional argument and SHALL receive neither a `-m` nor a `--model` nor an effort flag

### Requirement: An unavailable codex reviewer model SHALL surface codex's own error in the blocked-item evidence

When the reviewer command is `codex` and a configured model is forwarded that codex rejects (unknown or unavailable model id), the reviewer invocation SHALL exit nonzero and the item SHALL be blocked with evidence that includes codex's own CLI output and names the configured model id. The pipeline SHALL NOT silently fall back to a different model or to no-model.

#### Scenario: unknown codex model blocks with codex's error and the model name

- **WHEN** `review_harness: { command: codex, model: gpt-nonexistent }` is set and `codex exec -m gpt-nonexistent …` exits nonzero with an unknown-model error
- **THEN** the review item SHALL be blocked (not silently retried with a different model)
- **AND** the blocked-item evidence SHALL include codex's CLI output and the configured model id `gpt-nonexistent`

