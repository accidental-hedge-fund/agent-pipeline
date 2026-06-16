# harness-sandbox-mode Specification

## Purpose
TBD - created by archiving change harness-sandbox-mode. Update Purpose after archive.
## Requirements
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

### Requirement: Sandboxed claude planning and plan-revision invocations run from the issue worktree
When `cfg.harness_sandbox` is `true` and the implementer harness is `"claude"`, the non-OpenSpec planning stage SHALL pass the issue worktree path as the process cwd to `invoke()` for both plan-generation and plan-revision calls. Passing the shared repo root (`cfg.repo_dir`) as cwd when the sandbox is enabled would allow the sandboxed claude process to access sibling worktrees and the repo root rather than being confined to the issue's own worktree. When the harness is `"codex"`, `cfg.repo_dir` SHALL always be used as `worktreeDir` regardless of the sandbox flag — codex's `-C` argument must remain identical whether sandbox is enabled or not (see "sandboxed flag does not affect codex invocation" above).

#### Scenario: non-OpenSpec plan-gen uses issue worktree as cwd when sandboxed (claude)
- **WHEN** `cfg.harness_sandbox` is `true` and the harness is `"claude"` and the non-OpenSpec planning stage generates a plan
- **THEN** `invoke()` SHALL receive the issue worktree path as `worktreeDir`
- **AND** SHALL NOT receive `cfg.repo_dir` as `worktreeDir`

#### Scenario: non-OpenSpec plan-revision uses issue worktree as cwd when sandboxed (claude)
- **WHEN** `cfg.harness_sandbox` is `true` and the harness is `"claude"` and the non-OpenSpec planning stage revises a plan
- **THEN** `invoke()` SHALL receive the issue worktree path as `worktreeDir`
- **AND** SHALL NOT receive `cfg.repo_dir` as `worktreeDir`

#### Scenario: non-OpenSpec plan-gen with codex harness uses cfg.repo_dir regardless of sandbox flag
- **WHEN** `cfg.harness_sandbox` is `true` and the harness is `"codex"` and the non-OpenSpec planning stage generates a plan
- **THEN** `invoke()` SHALL receive `cfg.repo_dir` as `worktreeDir`
- **AND** the spawned codex args SHALL be identical to those produced when `sandbox` is `false`

#### Scenario: unsandboxed plan-gen preserves original cwd behavior
- **WHEN** `cfg.harness_sandbox` is `false` and the non-OpenSpec planning stage generates a plan
- **THEN** `invoke()` SHALL receive `cfg.repo_dir` as `worktreeDir` (preserving pre-change behavior)

