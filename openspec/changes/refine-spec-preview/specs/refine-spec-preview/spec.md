## ADDED Requirements

### Requirement: The `refine-spec` sub-command SHALL run without an issue number

The pipeline CLI SHALL accept `refine-spec` as a positional sub-command keyword that requires no issue number and does not advance any pipeline stage label. It SHALL be dispatched when the first positional argument is the string `refine-spec` (case-sensitive). A `--title "<text>"` flag SHALL supply the existing issue title and a `--body "<markdown>"` flag SHALL supply the existing issue body; omitting either SHALL exit non-zero with a usage error.

#### Scenario: Invoked with title and body flags

- **WHEN** the user runs `pipeline refine-spec --title "Add retry logic" --body "## Summary\n..."`
- **THEN** the command dispatches the refine-spec handler without reading or writing any pipeline stage label
- **AND** proceeds to the harness call

#### Scenario: Invoked with missing title

- **WHEN** the user runs `pipeline refine-spec --body "<markdown>"` with no `--title` flag
- **THEN** the command SHALL exit non-zero with a usage error identifying `--title` as required
- **AND** no harness call SHALL be made

#### Scenario: Invoked with missing body

- **WHEN** the user runs `pipeline refine-spec --title "Some title"` with no `--body` flag
- **THEN** the command SHALL exit non-zero with a usage error identifying `--body` as required
- **AND** no harness call SHALL be made

#### Scenario: Invoked with no arguments

- **WHEN** the user runs `pipeline refine-spec` with no flags
- **THEN** the command SHALL exit non-zero with a usage error
- **AND** no harness call SHALL be made

---

### Requirement: The `refine-spec` sub-command SHALL be discoverable via `--help` before invocation

The `refine-spec` sub-command SHALL respond to `pipeline refine-spec --help` with exit code 0 and SHALL print usage text describing its flags (`--title`, `--body`, `--json`). Additionally, `pipeline --help` SHALL list `refine-spec` alongside other no-issue-number sub-commands. A caller (e.g. Pipeline Desk) MAY probe for the contract's presence by invoking `pipeline refine-spec --help` and checking for a zero exit code before calling the command with real content.

#### Scenario: `--help` exits zero and prints usage

- **WHEN** `pipeline refine-spec --help` is invoked on an install that supports this contract
- **THEN** the command exits with code 0
- **AND** stdout or stderr contains usage text that mentions `--title` and `--body`

#### Scenario: Top-level help lists `refine-spec`

- **WHEN** `pipeline --help` is invoked
- **THEN** `refine-spec` SHALL appear in the sub-command list alongside `intake`, `release`, and peers

#### Scenario: Unknown command on older installs exits non-zero

- **WHEN** `pipeline refine-spec --help` is invoked on an install that does NOT support this contract
- **THEN** the command exits with a non-zero code
- **AND** a caller observing the non-zero exit knows the contract is unavailable

---

### Requirement: The `refine-spec` sub-command SHALL produce a machine-readable refined spec via a single model harness call

The handler SHALL invoke exactly one model harness call that takes the provided `--title` and `--body` and returns a refined spec following the WHAT-not-HOW / observable-AC section contract: **Summary** (one paragraph), **User story** (`As a … / I want … / so that …`), **Acceptance criteria** (`- [ ]` items stating observable, falsifiable behaviors), **Out of scope** (explicit exclusions), and **Open questions** only when the input is genuinely ambiguous. The harness call SHALL be the only model-invoking step; no other external calls are permitted.

#### Scenario: Well-specified input produces a complete spec

- **WHEN** the handler receives a non-trivial title and body
- **THEN** the harness returns a spec containing Summary, User story, Acceptance criteria, and Out of scope sections
- **AND** Open questions is absent or empty when the input is unambiguous
- **AND** exactly one harness call was made during the invocation

#### Scenario: Ambiguous input surfaces open questions

- **WHEN** the input body omits a decision the implementation requires (e.g., scope of a "cache" is not defined)
- **THEN** the refined spec SHALL include a non-empty Open questions section listing the unresolved decision(s)

#### Scenario: Harness call is the only model-invoking step

- **WHEN** `pipeline refine-spec` runs to stdout emission
- **THEN** exactly one model harness call SHALL have been made; all subsequent output formatting is deterministic given the harness response

---

### Requirement: The `refine-spec` sub-command SHALL emit a single unfenced JSON object to stdout

When invoked (with or without `--json`), the command SHALL write exactly one JSON object to stdout. The output SHALL NOT be wrapped in a markdown code fence, preceded by prose, or followed by trailing non-JSON bytes. The object SHALL contain at minimum: `title` (string), `body` (string), and `milestone` (string or null). `body` SHALL be the full markdown text of the refined spec. Additional fields beyond this minimum are permitted and do not constitute a breaking change. The exit code SHALL be 0 on success.

#### Scenario: Output is valid JSON with required fields

- **WHEN** `pipeline refine-spec --title "T" --body "B"` succeeds
- **THEN** stdout is a single valid JSON object (`JSON.parse(stdout)` succeeds)
- **AND** the object contains `title` (non-empty string), `body` (non-empty string), and `milestone` (string or null)
- **AND** stdout contains no surrounding prose or markdown code fences

#### Scenario: `--json` flag is accepted but behavior is identical

- **WHEN** `pipeline refine-spec --title "T" --body "B" --json` is invoked
- **THEN** the output is identical to invocation without `--json`
- **AND** the command exits 0

#### Scenario: Error is reflected in exit code

- **WHEN** the harness call fails (timeout, refusal, or malformed response)
- **THEN** the command exits non-zero
- **AND** no partial JSON object is written to stdout

---

### Requirement: The `refine-spec` sub-command SHALL perform no writes of any kind

The handler SHALL NOT create, edit, label, or comment on any GitHub issue or PR. It SHALL NOT create branches, make commits, or push to any remote. It SHALL NOT write to `ROADMAP.md` or any other tracked file. Re-running the command on the same input SHALL leave all repo and GitHub state unchanged. The `RefineSpecDeps` injectable interface SHALL contain no write-capable dependency slots (no `createIssue`, `writeFile`, `gitCreateBranch`, `createPR`, or equivalent), making the non-mutating guarantee structural rather than behavioral.

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
