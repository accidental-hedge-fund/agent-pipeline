## Context

Pipeline Desk is a desktop UI that needs to render backlog/run-detail/health panels without reimplementing pipeline state logic or GitHub queries. The existing `pipeline <issue> --status` and `pipeline doctor` commands already compute the right information; their output is prose-only today. The desktop app needs the same data in a stable, versioned JSON envelope.

Two prior pieces of art inform the design:
- CEP `ce-code-review` rule: *never wrap status JSON in a ``` ```json ``` fence* — a bare fence breaks `JSON.parse` consumers.
- gstack `bin/gstack-gbrain-detect`: always returns valid JSON even when checks fail; each check record is `{name, ok, reason, fix}` so the UI can render the exact fix command without further parsing.

## Goals / Non-Goals

**Goals:**
- Machine-readable JSON output for both `pipeline <issue> --status` and `pipeline doctor` via a `--json` flag.
- Silent `--is-ok` polling gate on `doctor` (exit 0/1, no stdout).
- Stable, versioned JSON envelope (`schema_version` + backward-compat field promise).
- Doctor JSON reuses existing check implementations — zero duplication.
- Human prose output unchanged for both commands.

**Non-Goals:**
- Streaming or chunked JSON output.
- A dedicated HTTP/REST API (Pipeline Desk polls the CLI).
- Real-time push events.
- Changes to pipeline state machine, review/fix logic, or GitHub label semantics.
- A second implementation of doctor checks (duplication is a hard non-goal).

## Decisions

### Decision 1: `--json` flag on existing subcommands, not new subcommands

**Chosen**: Add `--json` as an optional flag to `pipeline <issue> --status` and `pipeline doctor`.

**Why**: Keeps the CLI surface minimal. Callers that already script `--status` or `doctor` are unaffected. A new subcommand (`pipeline status-json`) would split documentation and mental model needlessly.

**Alternative considered**: Separate `pipeline status --format=json` parameter. Rejected — more verbose with no benefit over a boolean flag for this use case.

### Decision 2: Single unfenced JSON object, always valid

**Chosen**: Output is exactly one JSON object per invocation, no fences, no trailing newline variation. The command MUST NOT throw or print non-JSON to stdout when `--json` is active — errors are encoded inside the envelope as `"status": "error"` with an `"error"` field.

**Why**: CEP rule + practical contract: if `pipeline --json` ever emits a partial line of prose before crashing, every downstream `JSON.parse` call breaks silently. A structured error envelope lets Pipeline Desk display the error without special-casing exit codes.

**Alternative considered**: Exit non-zero with empty stdout on error. Rejected — forces consumers to handle both `stdout` and `stderr` to distinguish check failures from crashes.

### Decision 3: Doctor JSON reuses existing check runner via a formatter seam

**Chosen**: The doctor command already has `runPreflight(deps: DoctorDeps)` returning a structured result object. `--json` adds a second formatter (alongside the existing prose formatter) that serializes the same result object.

**Why**: Zero duplicated logic. The `DoctorDeps` seam already exists for testability; the JSON formatter is purely a presentation layer on top of it.

**Alternative considered**: Separate `DoctorJsonDeps` and re-implementing check routing. Rejected — creates two codepaths to maintain.

### Decision 4: `schema_version: "1"` string, bumped on breaking changes

**Chosen**: Top-level `"schema_version": "1"` (string, not integer) in every envelope. Breaking changes (field removals or type changes) bump the version. Additive fields are non-breaking and do not bump.

**Why**: Pipeline Desk can gate on schema_version before parsing field paths, giving us a safe upgrade path. String type matches common practice (e.g. Kubernetes API `apiVersion`); allows future semver if needed.

### Decision 5: `--is-ok` on `doctor` only — no output, exit code only

**Chosen**: `pipeline doctor --is-ok` exits 0 (all checks pass) or 1 (any check fails) with zero bytes on stdout. It shares the same check runner as `--json`.

**Why**: Allows cheap polling from a shell health-check without piping through `jq`. No output avoids accidental display in CI logs.

**Alternative considered**: `pipeline doctor --quiet`. Rejected — "quiet" conventionally means suppress non-error output, not all output; `--is-ok` is explicit about the contract.

### Decision 6: Status payload fields assembled from existing gh.ts / stage helpers

**Chosen**: The JSON status payload is assembled from data already fetched by the existing `--status` code path: issue metadata (`gh issue view`), PR info (`gh pr view`), label-derived stage, worktree path (from the worktree lifecycle helpers), and last pipeline event (from the issue's comment history). No new GitHub API calls beyond what the prose path already makes.

**Why**: Keeps the command read-only and safe to poll. No additional rate-limit pressure.

## Risks / Trade-offs

- **Schema churn risk** → Mitigated by `schema_version` + documented backward-compat promise (additive-only without a version bump). The proposal acceptance criteria define the minimum required fields; additional fields may be added freely.
- **Prose path regression** → Mitigated by keeping the JSON and prose formatters as separate output paths; the prose formatter is not modified. The acceptance criteria require byte-for-byte prose output compatibility, which tests will enforce.
- **Doctor check deduplication drift** → Mitigated by the formatter-seam design (Decision 3): there is one check runner, two formatters. If a new check is added to the human path, it is automatically available in the JSON path.
- **Missing fields for Pipeline Desk views** → The minimum field set is enumerated in the proposal's acceptance criteria. If Pipeline Desk M1-M5 need additional fields, they can be added as non-breaking additions without a version bump, within the documented backward-compat contract.

## Open Questions

- Should `last_event` be the last GitHub comment timestamp, the last label change, or both? Defer to implementation; spec requires the field exist with a timestamp + description.
- Should `worktree` include git status (clean/dirty) or just the path? Defer to implementation; spec requires the path field at minimum.
