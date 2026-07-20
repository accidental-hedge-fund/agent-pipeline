## MODIFIED Requirements

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

## ADDED Requirements

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
