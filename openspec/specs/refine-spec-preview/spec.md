# refine-spec-preview Specification

## Purpose
TBD - created by archiving change refine-spec-preview. Update Purpose after archive.

## Requirements

### Requirement: The `refine-spec` sub-command SHALL run without an issue number

The pipeline CLI SHALL accept `refine-spec` as a positional sub-command keyword that does not take a positional issue number and does not advance any pipeline stage label. It SHALL be dispatched when the first positional argument is the string `refine-spec` (case-sensitive). Callers SHALL supply either `--title "<text>"` and `--body "<markdown>"` together, or `--issue N` as specified by `grill-then-ready-refinement`. Omitting both the title/body pair and `--issue` SHALL exit non-zero with a usage error. Supplying `--issue` together with `--title` or `--body` SHALL exit non-zero with a usage error. No harness call SHALL be made on those usage errors.

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

---

### Requirement: The `refine-spec` sub-command SHALL be discoverable via `--help` before invocation

The `refine-spec` sub-command SHALL respond to `pipeline refine-spec --help` with exit code 0 and SHALL print usage text describing `--title`, `--body`, `--issue`, `apply`, `--proposal-file`, and `--json`. Additionally, `pipeline --help` SHALL list `refine-spec` alongside other no-issue-number sub-commands. A caller (e.g. Pipeline Desk) MAY probe for the contract's presence by invoking `pipeline refine-spec --help` and checking that the output contains usage text mentioning both `--title` and `--body` in a refine-spec context; an install that does not support this contract prints generic top-level help without refine-spec-specific flag descriptions.

#### Scenario: `--help` exits zero and prints usage

- **WHEN** `pipeline refine-spec --help` is invoked on an install that supports this contract
- **THEN** the command exits with code 0
- **AND** stdout or stderr contains usage text that mentions `--title` and `--body`
- **AND** the usage text SHALL mention `--issue`, `apply`, and `--proposal-file`

#### Scenario: Top-level help lists `refine-spec`

- **WHEN** `pipeline --help` is invoked
- **THEN** `refine-spec` SHALL appear in the sub-command list alongside `intake`, `release`, and peers

#### Scenario: Older installs print generic help without refine-spec-specific flags

- **WHEN** `pipeline refine-spec --help` is invoked on an install that does NOT support this contract
- **THEN** the output does NOT contain refine-spec-specific usage text describing `--title` and `--body` alongside the `refine-spec` command
- **AND** a caller checking that the output mentions both `--title` and `--body` in a refine-spec context can determine the contract is unavailable

---

### Requirement: The `refine-spec` sub-command SHALL produce a machine-readable refined spec via a single model harness call

When invoked with `--title` and `--body` (and without `--issue` or `apply`), the handler SHALL invoke exactly one model harness call that takes the provided `--title` and `--body` and returns a refined spec following the WHAT-not-HOW / observable-AC section contract: **Summary** (one paragraph), **User story** (`As a … / I want … / so that …`), **Acceptance criteria** (`- [ ]` items stating observable, falsifiable behaviors), **Out of scope** (explicit exclusions), and **Open questions** only when the input is genuinely ambiguous. That harness call SHALL be the only model-invoking step on this path; no other external calls are permitted. The `--issue` preview path SHALL use the two-call contract in `grill-then-ready-refinement` instead of this single-call contract. `apply` SHALL invoke no model.

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

### Requirement: The `refine-spec` sub-command SHALL validate that the harness response body contains required sections and at least one checkable criterion before emitting output

After parsing and shape-validating the harness JSON response, the handler SHALL verify that the `body` field contains the four required section headings (`## Summary`, `## User story`, `## Acceptance criteria`, `## Out of scope`) and at least one `- [ ]` item anywhere in the body text. If either condition is not met, the handler SHALL exit non-zero and write nothing to stdout.

#### Scenario: Body missing a required section exits non-zero

- **WHEN** the harness returns JSON whose `body` does not contain one or more of the required section headings
- **THEN** the handler SHALL exit non-zero with an error identifying the missing sections
- **AND** no JSON object is written to stdout

#### Scenario: Body with no checkable criterion exits non-zero

- **WHEN** the harness returns JSON whose `body` contains all required section headings but no `- [ ]` item
- **THEN** the handler SHALL exit non-zero with an error noting the missing criterion
- **AND** no JSON object is written to stdout

#### Scenario: Well-structured body passes validation

- **WHEN** the harness returns JSON whose `body` contains all four required section headings and at least one `- [ ]` item
- **THEN** body validation passes and the handler proceeds to emit the JSON result

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

Preview invocations — `pipeline refine-spec --title/--body` and `pipeline refine-spec --issue N` without `apply` — SHALL NOT create, edit, label, or comment on any GitHub issue or PR. They SHALL NOT create branches, make commits, or push to any remote. They SHALL NOT write to `ROADMAP.md` or any other tracked file. Re-running a preview on the same input SHALL leave all repo and GitHub state unchanged. The preview `RefineSpecDeps` injectable interface SHALL contain no write-capable dependency slots (no `createIssue`, `writeFile`, `gitCreateBranch`, `createPR`, or equivalent), making the non-mutating guarantee structural rather than behavioral. Body mutation is specified only by `grill-then-ready-refinement` apply and by hash-bound `pipeline handoff answer` materialize.

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
