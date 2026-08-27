## Purpose

Fail-closed execution policy: a runnable repository must declare both live harness roles in `.github/pipeline.yml` before any work starts. The invoking host profile is not a live-worker source.

## ADDED Requirements

### Requirement: Execution-policy resolution SHALL require a repository-declared implementer and reviewer

Shared configuration resolution for execution SHALL require `.github/pipeline.yml` at the resolved git root and SHALL require that file to declare both `harnesses.implementer` and `harnesses.reviewer` as non-empty strings. Direct CLI, every installed host launcher, and `single`, `loop` item dispatch, `train`, and `ship` SHALL use this same resolution. A launcher or profile SHALL NOT inject either live role.

#### Scenario: Complete declaration resolves under every profile

- **WHEN** `.github/pipeline.yml` sets `harnesses.implementer: grok` and `harnesses.reviewer: codex`
- **AND** configuration is resolved once under the `claude` profile and once under the `codex` profile
- **THEN** both resolutions SHALL set the live implementer to `grok` and the live reviewer to `codex`

#### Scenario: Host launcher does not inject live roles

- **WHEN** an installed host launcher starts an execution command with an injected `--profile`
- **AND** `.github/pipeline.yml` declares both harness roles
- **THEN** the resolved live implementer and reviewer SHALL equal the repository keys
- **AND** the launcher SHALL NOT write or override `harnesses.implementer` or `harnesses.reviewer`

### Requirement: Missing or partial repository harness policy SHALL fail closed before work

Configuration resolution for execution SHALL fail when the file is absent, when the `harnesses` block is absent, or when either `harnesses.implementer` or `harnesses.reviewer` is absent. The failure SHALL occur before a worktree is created or removed, before any GitHub mutation, and before any harness invocation. The diagnostic SHALL name the missing file or key and SHALL state that the active profile does not select live workers. The diagnostic for a missing file SHALL direct the operator to `pipeline init` and to set both role keys.

#### Scenario: Missing file fails before work

- **WHEN** the resolved git root has no `.github/pipeline.yml`
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic that names the missing file and `pipeline init`
- **AND** no worktree operation, GitHub mutation, or harness invocation SHALL have occurred

#### Scenario: Missing harnesses block fails closed

- **WHEN** `.github/pipeline.yml` exists and has no `harnesses:` block
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.implementer` and `harnesses.reviewer`
- **AND** the diagnostic SHALL state that the active profile does not fill live workers

#### Scenario: Implementer omitted fails closed

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `reviewer: codex`
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.implementer`
- **AND** the resolved reviewer SHALL NOT be taken from the active profile as a substitute

#### Scenario: Reviewer omitted fails closed

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `implementer: grok`
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.reviewer`

#### Scenario: review_harness without harnesses.reviewer is partial policy

- **WHEN** `.github/pipeline.yml` sets `review_harness: codex` and omits `harnesses.reviewer`
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.reviewer`
- **AND** `review_harness` SHALL NOT substitute for the missing key

### Requirement: Setup and dependency-free introspection SHALL keep their documented exemptions

`pipeline init` SHALL run when `.github/pipeline.yml` is absent so it can create the file. `--version`, `-V`, and `path` SHALL NOT require the file or either harness role. Those exemptions SHALL NOT invoke the implementer or reviewer harness and SHALL NOT create a worktree for stage work.

#### Scenario: Init creates a missing file

- **WHEN** `pipeline init` runs in a repository with no `.github/pipeline.yml`
- **THEN** the command SHALL write `.github/pipeline.yml` containing active `harnesses.implementer` and `harnesses.reviewer` keys
- **AND** it SHALL NOT fail solely because the file was absent at start

#### Scenario: Version flag does not require repository config

- **WHEN** `pipeline --version` or `pipeline -V` runs in a repository with no `.github/pipeline.yml`
- **THEN** the process SHALL print the version contract and exit 0

#### Scenario: Path command does not require repository config

- **WHEN** `pipeline path` runs in a repository with no `.github/pipeline.yml`
- **THEN** the command SHALL complete its documented path output
- **AND** it SHALL NOT fail because harness roles are undeclared

### Requirement: Coordinators SHALL apply the same gate before item work

`single`, `loop` item dispatch, `train`, and `ship` SHALL resolve execution configuration through the shared gate before that item's worktree, GitHub mutation, or harness invocation. A coordinator observation path that does not resolve execution configuration (for example `pipeline loop` logs) SHALL keep its documented behavior.

#### Scenario: Single fails closed on partial policy

- **WHEN** `pipeline single N` runs against a repository whose `.github/pipeline.yml` omits `harnesses.reviewer`
- **THEN** the command SHALL fail with the shared missing-role diagnostic
- **AND** no worktree, GitHub mutation, or harness invocation SHALL have occurred for that item

#### Scenario: Train and ship use the shared gate

- **WHEN** `pipeline train` or `pipeline ship` resolves configuration for a runnable repository with no `.github/pipeline.yml`
- **THEN** resolution SHALL fail with the shared missing-file diagnostic

#### Scenario: Loop item dispatch uses the shared gate

- **WHEN** a `pipeline loop` item would advance and the repository omits `harnesses.implementer`
- **THEN** that item SHALL fail closed through shared configuration resolution before its worktree or harness invocation
