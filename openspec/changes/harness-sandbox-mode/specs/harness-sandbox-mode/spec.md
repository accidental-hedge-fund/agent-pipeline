## ADDED Requirements

### Requirement: Sandbox flag routes claude invocation to native sandboxed permission mode
When `harness_sandbox` is `true` in the resolved config, `invoke()` SHALL pass `--permission-mode default` to the claude CLI instead of `--permission-mode bypassPermissions`. All other claude flags SHALL remain unchanged.

#### Scenario: sandboxed invocation uses default permission mode
- **WHEN** `InvokeOptions.sandbox` is `true` and the harness is `"claude"`
- **THEN** the spawned claude process SHALL receive `--permission-mode default` as an argument
- **AND** SHALL NOT receive `--permission-mode bypassPermissions`

#### Scenario: sandboxed flag does not affect codex invocation
- **WHEN** `InvokeOptions.sandbox` is `true` and the harness is `"codex"`
- **THEN** the spawned codex args SHALL be identical to those produced when `sandbox` is `false`

### Requirement: Default invocation is byte-identical when sandbox is disabled
When `InvokeOptions.sandbox` is `false` or absent, the spawned command and args SHALL be byte-identical to the pre-change behaviour for both built-in harnesses.

#### Scenario: default claude invocation unchanged
- **WHEN** `InvokeOptions.sandbox` is `false` and the harness is `"claude"`
- **THEN** the spawned claude process SHALL receive `--permission-mode bypassPermissions`

#### Scenario: default codex invocation unchanged
- **WHEN** `InvokeOptions.sandbox` is `false` and the harness is `"codex"`
- **THEN** the spawned codex args SHALL be identical to the current production invocation

### Requirement: Call sites forward harness_sandbox from resolved config to InvokeOptions
Each stage that calls `invoke()` SHALL read `cfg.harness_sandbox` from the resolved `PipelineConfig` and pass it as `InvokeOptions.sandbox`. The pipeline SHALL NOT call `invoke()` without forwarding this value when a resolved config is available.

#### Scenario: implementation stage forwards sandbox flag
- **WHEN** `cfg.harness_sandbox` is `true` and a harness invocation is made during the implementing stage
- **THEN** `InvokeOptions.sandbox` passed to `invoke()` SHALL be `true`

#### Scenario: review stage is unaffected
- **WHEN** the reviewer harness (cross-harness or configured) is invoked
- **THEN** `sandbox` SHALL default to `false` — only implementer/fix runs are sandboxed
