## MODIFIED Requirements

### Requirement: The `refine-spec` sub-command SHALL run without an issue number

The pipeline CLI SHALL accept `refine-spec` as a positional sub-command keyword that does not take a positional issue number and does not advance any pipeline stage label. It SHALL be dispatched when the first positional argument is the string `refine-spec` (case-sensitive). Callers SHALL supply `--title "<text>"` and `--body "<markdown>"` together for the supported Desk preview. Omitting the title/body pair SHALL exit non-zero with a usage error. Supplying `--issue` together with `--title` or `--body` SHALL exit non-zero with a usage error. No harness call SHALL be made on those usage errors. After replacement coverage, `--issue` and `apply` SHALL NOT be a second admission controller; they MAY emit a diagnostic that names `pipeline grill --issue N`.

#### Scenario: Invoked with title and body flags

- **WHEN** the user runs `pipeline refine-spec --title "Add retry logic" --body "## Summary\n..."`
- **THEN** the command dispatches the refine-spec handler without reading or writing any pipeline stage label
- **AND** proceeds to the harness call

#### Scenario: Invoked with missing title

- **WHEN** the user runs `pipeline refine-spec --body "<markdown>"` with no `--title` flag and no `--issue` flag
- **THEN** the command SHALL exit non-zero with a usage error identifying `--title` as required
- **AND** no harness call SHALL be made

#### Scenario: Invoked with missing body

- **WHEN** the user runs `pipeline refine-spec --title "Some title"` with no `--body` flag and no `--issue` flag
- **THEN** the command SHALL exit non-zero with a usage error identifying `--body` as required
- **AND** no harness call SHALL be made

#### Scenario: Invoked with no arguments

- **WHEN** the user runs `pipeline refine-spec` with no flags
- **THEN** the command SHALL exit non-zero with a usage error
- **AND** no harness call SHALL be made

#### Scenario: Issue flag is an alternate input not a positional issue number

- **WHEN** the user runs `pipeline refine-spec --issue 42`
- **THEN** the command SHALL dispatch the refine-spec handler
- **AND** SHALL NOT treat `42` as a positional advance issue number
- **AND** SHALL NOT advance any pipeline stage label

#### Scenario: Issue flag is not a positional issue number

- **WHEN** the user runs `pipeline refine-spec --issue 42`
- **THEN** the command SHALL NOT treat `42` as a positional advance issue number
- **AND** SHALL NOT advance any pipeline stage label
- **AND** SHALL NOT remain the admission writer after replacement coverage

---

### Requirement: The `refine-spec` sub-command SHALL be discoverable via `--help` before invocation

The `refine-spec` sub-command SHALL respond to `pipeline refine-spec --help` with exit code 0 and SHALL print usage text describing `--title`, `--body`, and `--json`. Additionally, `pipeline --help` SHALL list `refine-spec` alongside other no-issue-number sub-commands and SHALL list `grill` as the admission operation. A caller (e.g. Pipeline Desk) MAY probe for the contract's presence by invoking `pipeline refine-spec --help` and checking that the output contains usage text mentioning both `--title` and `--body` in a refine-spec context; an install that does not support this contract prints generic top-level help without refine-spec-specific flag descriptions.

#### Scenario: `--help` exits zero and prints usage

- **WHEN** `pipeline refine-spec --help` is invoked on an install that supports this contract
- **THEN** the command exits with code 0
- **AND** stdout or stderr contains usage text that mentions `--title` and `--body`

#### Scenario: Top-level help lists `refine-spec`

- **WHEN** `pipeline --help` is invoked
- **THEN** `refine-spec` SHALL appear in the sub-command list alongside `intake`, `release`, and peers

#### Scenario: Top-level help lists `refine-spec` and `grill`

- **WHEN** `pipeline --help` is invoked
- **THEN** `refine-spec` SHALL appear in the sub-command list alongside `intake`, `release`, and peers
- **AND** `grill` SHALL appear as the admission operation

#### Scenario: Older installs print generic help without refine-spec-specific flags

- **WHEN** `pipeline refine-spec --help` is invoked on an install that does NOT support this contract
- **THEN** the output does NOT contain refine-spec-specific usage text describing `--title` and `--body` alongside the `refine-spec` command
- **AND** a caller checking that the output mentions both `--title` and `--body` in a refine-spec context can determine the contract is unavailable

---

### Requirement: The `refine-spec` sub-command SHALL produce a machine-readable refined spec via a single model harness call

When invoked with `--title` and `--body` (and without `--issue` or `apply`), the handler SHALL invoke exactly one model harness call that takes the provided `--title` and `--body` and returns a refined spec following the WHAT-not-HOW / observable-AC section contract: **Summary** (one paragraph), **User story** (`As a … / I want … / so that …`), **Acceptance criteria** (`- [ ]` items stating observable, falsifiable behaviors), **Out of scope** (explicit exclusions), and **Open questions** only when the input is genuinely ambiguous. That harness call SHALL be the only model-invoking step on this path; no other external calls are permitted. The `--issue` preview path SHALL NOT remain the two-call admission contract after replacement coverage; admission SHALL be `pipeline grill` as specified by `grill-with-docs-admission`. `apply` SHALL NOT remain a permanent body-write controller.

#### Scenario: Well-specified input produces a complete spec

- **WHEN** the handler receives a non-trivial title and body
- **THEN** the harness returns a spec containing Summary, User story, Acceptance criteria, and Out of scope sections
- **AND** Open questions is absent or empty when the input is unambiguous
- **AND** exactly one harness call was made during the invocation

#### Scenario: Ambiguous input surfaces open questions

- **WHEN** the input body omits a decision the implementation requires (e.g., scope of a "cache" is not defined)
- **THEN** the refined spec SHALL include a non-empty Open questions section listing the unresolved decision(s)

#### Scenario: Harness call is the only model-invoking step

- **WHEN** `pipeline refine-spec --title "T" --body "B"` runs to stdout emission
- **THEN** exactly one model harness call SHALL have been made; all subsequent output formatting is deterministic given the harness response

---

### Requirement: The `refine-spec` sub-command SHALL perform no writes of any kind

Preview invocations — `pipeline refine-spec --title/--body` — SHALL NOT create, edit, label, or comment on any GitHub issue or PR. They SHALL NOT create branches, make commits, or push to any remote. They SHALL NOT write to `ROADMAP.md` or any other tracked file. Re-running a preview on the same input SHALL leave all repo and GitHub state unchanged. The preview `RefineSpecDeps` injectable interface SHALL contain no write-capable dependency slots (no `createIssue`, `writeFile`, `gitCreateBranch`, `createPR`, or equivalent), making the non-mutating guarantee structural rather than behavioral. Body mutation for admission SHALL belong to `pipeline grill` as specified by `grill-with-docs-admission`, and to hash-bound `pipeline handoff answer` materialize.

#### Scenario: No GitHub writes occur

- **WHEN** `pipeline refine-spec --title "T" --body "B"` runs to completion
- **THEN** no GitHub API write calls (issue creation, label application, comment posting, PR creation) are made

#### Scenario: No git writes occur

- **WHEN** `pipeline refine-spec --title "T" --body "B"` runs to completion
- **THEN** no branch is created, no commit is made, and no push is performed

#### Scenario: No filesystem writes occur

- **WHEN** `pipeline refine-spec --title "T" --body "B"` runs to completion
- **THEN** `ROADMAP.md` and all other tracked files are unmodified

#### Scenario: Idempotent on repeated invocation

- **WHEN** `pipeline refine-spec --title "T" --body "B"` is invoked twice in sequence
- **THEN** all repo and GitHub state is identical before and after both invocations
- **AND** each invocation MAY produce a different refined spec (model non-determinism), but neither alters any external state

#### Scenario: Issue preview is also non-mutating

- **WHEN** `pipeline refine-spec --issue N` runs to completion
- **THEN** no GitHub write, git write, or tracked-file write SHALL have been made
- **AND** after replacement coverage that path SHALL NOT remain the admission writer
