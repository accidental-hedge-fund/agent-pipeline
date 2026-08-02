## MODIFIED Requirements

### Requirement: InvokeOptions SHALL accept a reasoningEffort field for codex calls

`InvokeOptions` in `harness.ts` SHALL accept an optional `reasoningEffort` string field.
When `harness === "codex"` and `reasoningEffort` is set, `invoke()` SHALL append
`-c model_reasoning_effort=<value>` to the codex args immediately before the prompt-delivery
sentinel (or historical prompt positional). When `reasoningEffort` is absent or the harness is not
`"codex"`, the field SHALL be silently ignored. The Codex managed-sandbox selector in these args
SHALL be consecutive `--sandbox` + `workspace-write` and SHALL NOT be `--full-auto`. The managed
args SHALL NOT include post-`exec` approval-policy tokens (`-a`, `--ask-for-approval`).

#### Scenario: reasoningEffort passed to codex args

- **WHEN** `invoke("codex", dir, prompt, { reasoningEffort: "medium" })` is called without
  external-bypass selection
- **THEN** the codex process SHALL be spawned with args that include
  `["exec", "--sandbox", "workspace-write", "-C", dir, "-c", "model_reasoning_effort=medium"]`
  (plus the adapter's documented prompt-delivery sentinel)
- **AND** the args SHALL NOT include `--full-auto`
- **AND** the args SHALL NOT include `-a` or `--ask-for-approval`

#### Scenario: reasoningEffort absent — args unchanged except managed-sandbox flags

- **WHEN** `invoke("codex", dir, prompt, {})` is called without `reasoningEffort` and without
  external-bypass selection
- **THEN** the codex process SHALL be spawned with args that include
  `["exec", "--sandbox", "workspace-write", "-C", dir]` (no reasoning-effort flag)
- **AND** the args SHALL NOT include `--full-auto`
- **AND** the args SHALL NOT include `-a` or `--ask-for-approval`

#### Scenario: reasoningEffort ignored for claude harness

- **WHEN** `invoke("claude", dir, prompt, { reasoningEffort: "medium" })` is called
- **THEN** the claude process SHALL NOT include any `-c model_reasoning_effort` flag
- **AND** the claude invocation SHALL be unchanged from its prior shape
