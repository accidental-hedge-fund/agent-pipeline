## MODIFIED Requirements

### Requirement: invoke() accepts an arbitrary string harness name

`invoke()` SHALL accept a `string` for the `harness` parameter. For `"claude"` and `"codex"`, the
invocation shapes are the established adapter shapes (including the Codex managed-sandbox migration
from deprecated `--full-auto` to `--sandbox workspace-write`) apart from the prompt-delivery
channel each adapter declares. For any other string value, `invoke()` SHALL spawn the CLI named by
the string, deliver the prompt on the configured prompt-delivery channel — a positional argument by
default — capture its stdout as the harness output, and surface a specific failure message when the
CLI cannot be spawned.

#### Scenario: built-in claude harness invocation unchanged apart from prompt delivery

- **WHEN** `invoke("claude", ...)` is called
- **THEN** the `claude` CLI SHALL be invoked with `--print --permission-mode bypassPermissions --output-format text` flags, as before this change
- **AND** the prompt SHALL be delivered on the channel the `claude` adapter declares rather than as a positional argument

#### Scenario: built-in codex harness invocation uses non-deprecated managed-sandbox flags

- **WHEN** `invoke("codex", ...)` is called without external-bypass selection
- **THEN** the `codex` CLI SHALL be invoked with `exec --sandbox workspace-write -C <worktreeDir>` flags (and SHALL NOT receive `--full-auto`)
- **AND** the prompt SHALL be delivered on the channel the `codex` adapter declares rather than as a positional argument

#### Scenario: custom harness string is spawned with the configured prompt delivery

- **WHEN** `invoke("my-reviewer", worktreeDir, prompt, opts)` is called with no prompt-delivery selection configured
- **THEN** `my-reviewer` SHALL be spawned with the prompt as a positional argument and its stdout SHALL be returned as the harness output
