# configurable-review-harness Specification

## Purpose
TBD - created by archiving change configurable-review-harness. Update Purpose after archive.

## Requirements

### Requirement: review_harness config key overrides the profile reviewer

`PartialConfigSchema` SHALL accept an optional `review_harness` key that is either a bare `string` (the command shorthand) or a strict object `{ command: string, model?: string | "auto", effort?: string | "auto" }`. `review_harness` SHALL be a structured overlay on the required repository `harnesses.reviewer` key. It SHALL NOT replace `harnesses.reviewer` and SHALL NOT take the live reviewer from the active profile.

When `review_harness` is present in either form and `harnesses.reviewer` is absent, execution-policy resolution SHALL fail closed. When both are present they SHALL agree: naming the same command is accepted and the structured `review_harness` model/effort/prompt-delivery settings continue to apply, while naming different commands SHALL be rejected with a message naming both keys and both values rather than silently selecting one. For the object form, `resolveConfig()` SHALL set `cfg.harnesses.reviewerModel` from `model` and `cfg.harnesses.reviewerEffort` from `effort`; for the string form, both SHALL remain unset. When `review_harness` is absent and `harnesses.reviewer` is present, the live reviewer SHALL be `harnesses.reviewer` and `reviewerModel`/`reviewerEffort` SHALL remain unset.

`PartialConfigSchema` SHALL continue to accept the strict repository `harnesses` role block (see `configurable-harness-roles`); a key inside it other than `implementer` or `reviewer` SHALL still be rejected by strict validation.

#### Scenario: review_harness string form present

- **WHEN** `.github/pipeline.yml` sets `harnesses.reviewer: my-reviewer` and `review_harness: my-reviewer` and also declares `harnesses.implementer`
- **THEN** `resolveConfig()` SHALL set `cfg.harnesses.reviewer` to `"my-reviewer"`, and `cfg.harnesses.reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: review_harness object form present

- **WHEN** `.github/pipeline.yml` sets `harnesses.reviewer: claude` and `review_harness: { command: claude, model: claude-fable-5, effort: max }` and also declares `harnesses.implementer`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"claude"`, `cfg.harnesses.reviewerModel` SHALL be `"claude-fable-5"`, and `cfg.harnesses.reviewerEffort` SHALL be `"max"`

#### Scenario: review_harness key absent

- **WHEN** `.github/pipeline.yml` does not include a `review_harness` key and no `harnesses` block
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail closed
- **AND** `cfg.harnesses.reviewer` SHALL NOT equal the profile's default reviewer harness

#### Scenario: review_harness key absent under claude profile

- **WHEN** the `claude` profile is active and `.github/pipeline.yml` has no `review_harness` key and no `harnesses` block
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail closed
- **AND** `cfg.harnesses.reviewer` SHALL NOT be `"codex"` by profile default

#### Scenario: harnesses.reviewer supplies the reviewer when review_harness is absent

- **WHEN** `.github/pipeline.yml` sets `harnesses: { implementer: grok, reviewer: codex }` and no `review_harness` key
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` and `reviewerModel`/`reviewerEffort` SHALL be unset

#### Scenario: agreeing review_harness and harnesses.reviewer

- **WHEN** `.github/pipeline.yml` sets `harnesses: { implementer: grok, reviewer: codex }` and `review_harness: { command: codex, model: gpt-5.6-terra }`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"codex"` and `cfg.harnesses.reviewerModel` SHALL be `"gpt-5.6-terra"`

#### Scenario: conflicting review_harness and harnesses.reviewer

- **WHEN** `.github/pipeline.yml` sets `harnesses: { reviewer: codex }` and `review_harness: claude`
- **THEN** `resolveConfig()` SHALL fail with a message naming both keys and both values, and no stage SHALL run

#### Scenario: review_harness without harnesses.reviewer fails closed

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer` and no `harnesses` block
- **THEN** execution-policy resolution SHALL fail with a diagnostic naming `harnesses.reviewer`

### Requirement: invoke() accepts an arbitrary string harness name

`invoke()` SHALL accept a `string` for the `harness` parameter. For `"claude"` and `"codex"`, the
invocation shapes are the established adapter shapes (including the Codex managed-sandbox migration
from deprecated `--full-auto` to consecutive `--sandbox` + `workspace-write`, without post-`exec`
approval-policy tokens) apart from the prompt-delivery channel each adapter declares. For any other
string value, `invoke()` SHALL spawn the CLI named by the string, deliver the prompt on the
configured prompt-delivery channel — a positional argument by default — capture its stdout as the
harness output, and surface a specific failure message when the CLI cannot be spawned.

#### Scenario: built-in claude harness invocation unchanged apart from prompt delivery

- **WHEN** `invoke("claude", ...)` is called
- **THEN** the `claude` CLI SHALL be invoked with `--print --permission-mode bypassPermissions --output-format text` flags, as before this change
- **AND** the prompt SHALL be delivered on the channel the `claude` adapter declares rather than as a positional argument

#### Scenario: built-in codex harness invocation uses non-deprecated managed-sandbox flags

- **WHEN** `invoke("codex", ...)` is called without external-bypass selection
- **THEN** the `codex` CLI SHALL be invoked with
  `exec --sandbox workspace-write -C <worktreeDir>` flags
- **AND** the invocation SHALL NOT receive `--full-auto`
- **AND** the invocation SHALL NOT receive `-a` or `--ask-for-approval` after `exec`
- **AND** the prompt SHALL be delivered on the channel the `codex` adapter declares rather than as a positional argument

#### Scenario: custom harness string is spawned with the configured prompt delivery

- **WHEN** `invoke("my-reviewer", worktreeDir, prompt, opts)` is called with no prompt-delivery selection configured
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

The resolved reviewer **model** SHALL be validated against the effective reviewer command before it reaches the harness invocation: when the resolved model is an alias the effective reviewer harness cannot run — determined from that harness adapter's capabilities and recognized aliases rather than a hard-coded pair of harness names, e.g. a claude-only alias such as `claude-fable-5`, `sonnet`, or `opus` reaching a `codex` reviewer — the review routing SHALL pass no model to the invocation (so the reviewer CLI receives no model flag and uses its configured default) rather than forwarding the unrunnable alias. An explicit (non-`auto`) reviewer model SHALL be forwarded verbatim to the reviewer command regardless of harness.

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

#### Scenario: codex reviewer configured through the harnesses block behaves identically

- **WHEN** the reviewer is resolved from `harnesses: { reviewer: codex }` rather than `review_harness`, and `models.review` is `"auto"`
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

### Requirement: A configured reviewer CLI SHALL support an explicit standard-input prompt-delivery selection

The configuration for a custom reviewer CLI (`review_harness`) SHALL accept an explicit
prompt-delivery selection choosing between a positional argument and the CLI's standard input. The
default SHALL be the positional argument, keeping the invocation shape byte-for-byte identical to
the pre-change behavior. When standard input is selected, the CLI SHALL be spawned with no prompt
positional and the prompt SHALL be written to its standard input.

#### Scenario: Default custom reviewer invocation is unchanged

- **WHEN** a custom reviewer CLI is configured without a prompt-delivery selection and is invoked
  with a prompt below the per-argument limit
- **THEN** it SHALL be spawned as `<cmd> <prompt>` exactly as before this change
- **AND** its stdout SHALL be parsed as the verdict exactly as before this change

#### Scenario: Standard-input delivery is selected for a custom reviewer

- **WHEN** a custom reviewer CLI is configured with standard-input prompt delivery
- **THEN** the CLI SHALL be spawned with no prompt positional argument
- **AND** the prompt SHALL be delivered in full as its standard-input payload, regardless of prompt
  size

#### Scenario: An oversize prompt on the default positional delivery is refused with the remedy named

- **WHEN** a custom reviewer CLI configured with positional delivery is invoked with a prompt
  exceeding the per-argument limit
- **THEN** the CLI SHALL NOT be spawned
- **AND** the surfaced failure SHALL name the per-argument limit, the measured prompt size, and the
  standard-input prompt-delivery selection as the remedy

### Requirement: Custom reviewer CLIs SHALL resolve through the adapter extension contract rather than a permanent raw-spawn bypass

`invoke()` and review routing SHALL treat an unregistered reviewer command as a compatibility
registration of the public adapter extension contract (see `adapter-extension-registry`), not as a
permanent special-case spawn that skips capability preflight, treatment identity, and normalized
failure classification. Existing `review_harness` string and object forms (including
`prompt_delivery`) SHALL keep their configured behavior. When the reviewer name matches a
registered full adapter, that adapter SHALL win over the compatibility path.

#### Scenario: review_harness string uses compatibility adapter path

- **WHEN** `review_harness: my-reviewer` is configured and `my-reviewer` is not a registered full
  adapter package
- **THEN** reviewer invocation SHALL still spawn `my-reviewer` with the configured prompt-delivery
  channel
- **AND** the invocation path SHALL use the extension-contract compatibility adapter rather than a
  harness-name branch that bypasses the adapter interface

#### Scenario: review_harness object retains model, effort, and prompt_delivery

- **WHEN** `review_harness: { command: my-reviewer, model: auto, effort: high, prompt_delivery: stdin }`
  is configured
- **THEN** resolution SHALL preserve command, model, effort, and stdin prompt delivery exactly as
  before the migration
- **AND** those settings SHALL be applied through the compatibility adapter's declared surface

#### Scenario: Registered full adapter wins over compatibility

- **WHEN** package registration supplies a full adapter for ID `my-reviewer`
- **AND** `review_harness: my-reviewer` is configured
- **THEN** invocation SHALL use the full registered adapter
- **AND** the thin compatibility adapter SHALL NOT override it

#### Scenario: Unspawnable custom reviewer still yields an actionable error

- **WHEN** the configured custom reviewer CLI is missing from `PATH`
- **THEN** the surfaced error SHALL name the CLI
- **AND** the failure classification SHALL be compatible with the public missing-CLI vocabulary
  used for registered adapters
