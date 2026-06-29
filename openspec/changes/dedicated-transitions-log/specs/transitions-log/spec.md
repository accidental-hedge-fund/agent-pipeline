## ADDED Requirements

### Requirement: Pipeline mirrors stage-transition lifecycle lines to a dedicated transitions log
The pipeline orchestrator SHALL append every `[pipeline] #N:` lifecycle line it prints to stdout to a dedicated, append-only transitions log so that stage changes can be followed without parsing the full combined output. The set of mirrored lines SHALL include: the run-start lines (`starting at stage=<stage>` and `run id <id>`), each advancing transition line (`<from> → <to>: <summary>`), each non-advancing outcome line (`at <stage> — <status>: <reason>`), the `unblocked at <stage>` line, the `pipeline label removed; stopping.` line, and the terminal `done — …` line. Lines that are NOT pipeline lifecycle lines (harness/CI prose, test-runner stdout, `gh` output) SHALL NOT be written to the transitions log.

#### Scenario: An advancing transition is mirrored
- **WHEN** the orchestrator prints `[pipeline] #N: <from> → <to>: <summary>` to stdout
- **THEN** the identical line SHALL be appended to the transitions log

#### Scenario: A blocked outcome is mirrored
- **WHEN** the orchestrator prints `[pipeline] #N: at <stage> — blocked: <reason>` to stdout
- **THEN** the first physical line of that string (the lifecycle header before any embedded newline in `<reason>`) SHALL be appended to the transitions log

#### Scenario: Run-start and run-done lines are mirrored
- **WHEN** the orchestrator prints the `starting at stage=…`, `run id …`, or terminal `done — …` lifecycle line
- **THEN** each such line SHALL be appended to the transitions log

#### Scenario: The unblocked line is mirrored
- **WHEN** the orchestrator prints `[pipeline] #N: unblocked at <stage>`
- **THEN** the identical line SHALL be appended to the transitions log

#### Scenario: Outcome from the common post-dispatch path is mirrored
- **WHEN** the dispatch loop's shared post-dispatch path calls `printOutcome` after a stage returns any outcome (advancing or non-advancing)
- **THEN** the `tlog` callback SHALL be supplied to `printOutcome` at every call site — including the common post-dispatch path — so no stage-completion outcome line escapes mirroring

#### Scenario: Non-lifecycle output is not mirrored
- **WHEN** the test gate dumps unit-test fixture output containing substrings like `[pipeline] #999:` or `→ ready-to-deploy`
- **THEN** none of that fixture output SHALL appear in the transitions log

### Requirement: The tlog closure normalizes each lifecycle string to its first physical line before writing
Before appending any lifecycle string to the transitions log, the orchestrator's `tlog` closure SHALL apply `singleLifecycleLine()` — which strips leading whitespace then returns only the content before the first embedded newline — so that multiline outputs (blocked-outcome reasons embedding test-gate fixture text, and the terminal done line that prefixes a leading `\n` for terminal visual spacing) are each written as a single unambiguous line.

#### Scenario: Single-line lifecycle string written verbatim
- **WHEN** `tlog` is called with a string containing no leading whitespace and no embedded newlines
- **THEN** the string written to the transitions log SHALL equal the input verbatim

#### Scenario: Done line has leading newline stripped
- **WHEN** `tlog` is called with the terminal done line (which carries a leading `\n` for terminal visual spacing)
- **THEN** the string written to the transitions log SHALL be the lifecycle content with the leading whitespace stripped, containing no leading newline

#### Scenario: Blocked outcome with embedded multiline reason — only header written
- **WHEN** a blocked-outcome reason string embeds one or more newlines (e.g., test-gate fixture output appended after the lifecycle header line)
- **THEN** only the content up to (but not including) the first embedded newline SHALL be written to the transitions log

### Requirement: The transitions log path follows the per-issue /tmp naming convention
The transitions log SHALL be located at `/tmp/pipeline-<domain>-<N>.transitions.log`, where `<domain>` is the active `cfg.domain` and `<N>` is the issue number the run was invoked with. This mirrors the existing `/tmp/pipeline-<domain>.lock`, `/tmp/pipeline-<domain>.disabled`, and `/tmp/pipeline-<domain>-<N>.log` naming so an operator can derive the path from the run arguments alone.

#### Scenario: Path derived from domain and issue number
- **WHEN** the pipeline runs for issue N with domain `<domain>`
- **THEN** the transitions log SHALL be written to `/tmp/pipeline-<domain>-<N>.transitions.log`

#### Scenario: PR resolved to its linked issue uses the original argument number
- **WHEN** the pipeline is invoked with a number that resolves to a different linked issue
- **THEN** the transitions log path SHALL use the same `<N>` that the full operator log path uses (the originally supplied argument), so both logs share the same `<N>`

#### Scenario: transitionsLogN seam decouples log path from resolved issue number
- **WHEN** `runAdvance` is called after PR→issue resolution and a `transitionsLogN` value is provided via `AdvanceDeps`
- **THEN** the transitions log path SHALL be derived from `transitionsLogN` rather than the resolved `issueNumber`, so unit tests and callers can independently verify both the GitHub operations (which use `issueNumber`) and the transitions log path (which uses the original argument)

#### Scenario: runUnblock uses original argument number for transitions log path
- **WHEN** `runUnblock` is called with an `originalN` parameter that differs from the resolved `issueNumber`
- **THEN** the `unblocked at <stage>` lifecycle line SHALL be appended to `/tmp/pipeline-<domain>-<originalN>.transitions.log`, not the path derived from the resolved `issueNumber`

#### Scenario: runOverride threads original argument as transitionsLogN to runAdvance
- **WHEN** `runOverride` is called with an `originalN` parameter that differs from the resolved `issueNumber`
- **THEN** it SHALL pass `transitionsLogN: originalN` to `runAdvance`, so all advance-loop lifecycle lines produced by the resumed run use the original argument's transitions log path

### Requirement: The transitions log is append-only and additive to the full log
The transitions log SHALL be opened in append mode and SHALL NOT truncate existing content, so successive dispatches for the same issue accumulate in one file. Mirroring SHALL be strictly additive: every line written to the full log (stdout) before this change SHALL still be written there, and each mirrored line SHALL be byte-for-byte identical to the line written to stdout.

#### Scenario: Second dispatch appends rather than truncates
- **WHEN** a second pipeline dispatch runs for the same issue N and domain
- **THEN** the transitions log SHALL retain the prior dispatch's lines and append the new dispatch's lifecycle lines after them

#### Scenario: Full log is unchanged
- **WHEN** the pipeline runs with the transitions log enabled
- **THEN** stdout / the full log SHALL contain exactly the lines it contained before this change, with no lines removed or reformatted

#### Scenario: Mirrored line matches the stdout line verbatim for single-line output
- **WHEN** a lifecycle string is a single physical line (no leading whitespace, no embedded newlines)
- **THEN** the transitions-log copy SHALL equal the stdout copy with no added prefix, timestamp, or reformatting

#### Scenario: Mirrored line is normalized for multiline output
- **WHEN** a lifecycle string contains leading whitespace or embedded newlines
- **THEN** the transitions-log copy SHALL be the first physical line of that string after leading-whitespace stripping, as produced by `singleLifecycleLine()`

### Requirement: A transitions-log write failure is non-fatal
A failure to open or append to the transitions log SHALL NOT abort the run or alter the full-log output. The orchestrator SHALL continue the dispatch and SHALL still print the lifecycle line to stdout.

#### Scenario: Transitions-log write fails
- **WHEN** appending a lifecycle line to the transitions log raises an error (e.g. `/tmp` is unwritable)
- **THEN** the line SHALL still be printed to stdout
- **AND** the run SHALL continue without raising

### Requirement: Host orchestration guidance recommends the transitions log for monitoring
The operator orchestration guidance in all SKILL.md host variants (`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, and the generated `plugin/pipeline/skills/pipeline/SKILL.md`) SHALL document the transitions log as the recommended source for monitoring stage transitions, showing a grep-free `tail -f /tmp/pipeline-<domain>-<N>.transitions.log` invocation. The guidance SHALL state that the transitions log contains only pipeline lifecycle lines, so it is not subject to the test-gate fixture false matches that affect the full log.

#### Scenario: Claude host guidance references the transitions log
- **WHEN** `hosts/claude/SKILL.md` monitoring guidance is read
- **THEN** it SHALL show `tail -f /tmp/pipeline-<domain>-<N>.transitions.log` as the recommended monitor source with no grep filter

#### Scenario: Codex host guidance references the transitions log
- **WHEN** `hosts/codex/SKILL.md` monitoring guidance is read
- **THEN** it SHALL reference the same `/tmp/pipeline-<domain>-<N>.transitions.log` path as the recommended monitor source

#### Scenario: Generated plugin mirror stays consistent
- **WHEN** `plugin/pipeline/skills/pipeline/SKILL.md` is read after the build mirror is regenerated
- **THEN** its monitoring guidance SHALL match the `hosts/claude` source's transitions-log guidance

### Requirement: Cleanup removes the transitions log for swept merged-PR issues
When `pipeline --cleanup` sweeps a pipeline-managed worktree whose PR is merged, it SHALL also remove the corresponding `/tmp/pipeline-<domain>-<N>.transitions.log` for that issue if present, so the transitions logs do not accumulate in `/tmp`. Removal SHALL be best-effort: a missing file is not an error, and a removal failure SHALL NOT abort the rest of the sweep.

#### Scenario: Transitions log removed for a merged-PR issue
- **WHEN** `pipeline --cleanup` removes the merged-PR worktree for issue N
- **THEN** `/tmp/pipeline-<domain>-<N>.transitions.log` SHALL be removed if it exists

#### Scenario: Missing transitions log is not an error
- **WHEN** `pipeline --cleanup` sweeps issue N but no `/tmp/pipeline-<domain>-<N>.transitions.log` exists
- **THEN** the sweep SHALL complete successfully without reporting an error for that issue
