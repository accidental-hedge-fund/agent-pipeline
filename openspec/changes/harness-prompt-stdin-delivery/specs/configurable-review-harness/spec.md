## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: invoke() accepts an arbitrary string harness name

`invoke()` SHALL accept a `string` for the `harness` parameter. For `"claude"` and `"codex"`, the
invocation shapes are unchanged apart from the prompt-delivery channel each adapter declares. For any
other string value, `invoke()` SHALL spawn the CLI named by the string, deliver the prompt on the
configured prompt-delivery channel — a positional argument by default — capture its stdout as the
harness output, and surface a specific failure message when the CLI cannot be spawned.

#### Scenario: built-in claude harness invocation unchanged apart from prompt delivery

- **WHEN** `invoke("claude", ...)` is called
- **THEN** the `claude` CLI SHALL be invoked with `--print --permission-mode bypassPermissions --output-format text` flags, as before this change
- **AND** the prompt SHALL be delivered on the channel the `claude` adapter declares rather than as a positional argument

#### Scenario: built-in codex harness invocation unchanged apart from prompt delivery

- **WHEN** `invoke("codex", ...)` is called
- **THEN** the `codex` CLI SHALL be invoked with `exec --full-auto -C <worktreeDir>` flags, as before this change
- **AND** the prompt SHALL be delivered on the channel the `codex` adapter declares rather than as a positional argument

#### Scenario: custom harness string is spawned with the configured prompt delivery

- **WHEN** `invoke("my-reviewer", worktreeDir, prompt, opts)` is called with no prompt-delivery selection configured
- **THEN** `my-reviewer` SHALL be spawned with the prompt as a positional argument and its stdout SHALL be returned as the harness output
