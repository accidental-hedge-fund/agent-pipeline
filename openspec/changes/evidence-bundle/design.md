## Context

The pipeline is a label-driven state machine. `pipeline.ts` is the orchestrator: it reads the current label, dispatches to the matching stage module in `stages/*.ts`, and loops. Each stage module performs its work (spawn harness, run command, post comment, transition label) and returns. There is no shared mutable object threaded through a run today — stage modules call `gh`/harness helpers directly and are otherwise independent.

The pipeline writes two kinds of persisted state today:

1. **GitHub state**: labels, PR comments, issue comments — authoritative and visible to maintainers.
2. **Worktree**: the code changes and commits produced by harness invocations — visible via git.

There is no structured local record of what the pipeline *did* during a run. Debugging requires reading GitHub comments in order, cross-referencing commits with their messages, and checking stage logs if available.

## Goals / Non-Goals

**Goals:**

- Write a single JSON file per run to a stable, issue-scoped path. The file accumulates evidence incrementally as stages execute.
- Record enough to answer: what ran, in what order, with what outcome, and what the reviewer said.
- Keep the format machine-readable (JSON) with a human-readable summary printable on demand.
- Never record sensitive values (raw env vars, tokens, secrets).
- Notify the PR/issue of the bundle path once at finalization so the artifact is discoverable.
- Preserve zero behavioral impact: the bundle is write-only from the pipeline's perspective; nothing reads it to make decisions.

**Non-Goals:**

- Full prompt/response transcript capture (too large; the harness already has its own logs).
- Replacing GitHub comments or labels as the source of truth.
- Uploading bundles to GitHub or any remote by default.
- Providing a queryable API over bundles; this is a file, not a service.
- Retroactively creating bundles for past runs.

## Decisions

### D1: Bundle file location

**Decision**: Write the bundle to `<state_dir>/<issueNumber>/evidence.json`, where `state_dir` is the existing pipeline state directory (already used by lock, worktree metadata, and similar files). If the issue directory does not exist, create it.

**Alternative considered**: write to the worktree root (`.pipeline/evidence.json`). Rejected: the worktree is ephemeral — it is deleted at `ready-to-deploy`. The state directory survives the run and is the conventional place for issue-scoped pipeline files.

**Alternative considered**: a new top-level `runs/` directory. Rejected: would scatter state across a second location with no benefit; the existing state directory already handles issue-scoped files.

### D2: JSON format with a `schemaVersion` field

**Decision**: The bundle is a single JSON object with a top-level `"schemaVersion": 1` field. A breaking schema change increments the version; readers can gate on it.

```jsonc
{
  "schemaVersion": 1,
  "runId": "147/2026-06-14T20:48:55Z",
  "issue": 147,
  "pr": 456,               // null if no PR yet
  "branch": "pipeline/147-evidence-bundle",
  "harnesses": ["claude"],
  "stages": [
    {
      "stage": "planning",
      "enteredAt": "2026-06-14T20:48:55Z",
      "exitedAt": "2026-06-14T20:53:10Z",
      "outcome": "advanced",
      "commits": ["abc1234"],
      "commands": [
        { "cmd": "npm test", "exitCode": 0, "durationMs": 4210 }
      ]
    }
  ],
  "reviews": [
    {
      "round": 1,
      "sha": "abc1234",
      "verdict": "approved",
      "findingCounts": { "critical": 0, "high": 0, "medium": 1, "low": 2 }
    }
  ],
  "overrides": [
    { "key": "abc123...", "reason": "out of scope for this issue" }
  ],
  "recoveries": [
    { "trigger": "ci-failure", "round": 1, "at": "2026-06-14T21:05:00Z" }
  ],
  "finalState": "ready-to-deploy",   // null until finalized
  "finalizedAt": "2026-06-14T21:30:00Z"
}
```

### D3: Incremental write strategy (read-modify-write)

**Decision**: Each call to the bundle writer reads the existing JSON, applies the update to the in-memory object, and writes it back atomically (write to a `.tmp` file, then `fs.rename()`). This is safe for single-process serial execution (the pipeline loop is not concurrent per issue).

**Alternative considered**: append-only JSONL. Rejected: harder to read as a whole, harder to update `finalState`, and the file size is small enough that rewrite is negligible.

**Alternative considered**: an in-memory object flushed at the end. Rejected: if the pipeline crashes mid-run the in-memory state is lost; incremental writes make partial runs inspectable.

### D4: Sensitive value exclusion

**Decision**: The bundle writer module MUST NOT accept raw env var values or any parameter whose name suggests a secret (token, key, password, secret). The writer's API accepts only structured, typed parameters (strings, numbers, enums). Callers pass summarized outcomes, not raw subprocess output beyond a capped excerpt.

Command stdout/stderr: truncated to 500 characters in the bundle (same cap as review raw output in comments). The full output is not stored.

### D5: PR/issue notification

**Decision**: At finalization, post a single comment on the PR (or issue if no PR) with the bundle path. The comment is minimal: `Evidence bundle written to: <path>`. It is posted once; if the bundle already has a notification SHA recorded, skip re-posting. This avoids duplicate comments on re-runs within the same issue.

**Alternative considered**: append the path to an existing pipeline comment. Rejected: would require finding and editing an existing comment, fragile to comment-not-found edge cases. A standalone comment is simpler and discoverable.

### D6: `--summary` flag on the CLI

**Decision**: Add `--summary <issueNumber>` to `pipeline.ts` CLI. When this flag is present, the CLI reads the bundle for the given issue, formats it as human-readable text (stage table, review outcomes, overrides, final state), prints it, and exits. No pipeline loop is entered.

**Alternative considered**: a separate `pipeline-summary` command. Rejected: the CLI already has multiple modes (`--status`, `--init`); adding `--summary` follows the same pattern.

### D7: Dependency injection for tests

**Decision**: The bundle writer module accepts an optional `deps` parameter (same pattern as `AdvanceReviewDeps`, `ShaGateDeps`, etc.) for `readFile`, `writeFile`, and `rename`. Tests inject in-memory fakes; production uses `fs/promises`.

### D8: Bundle writer is a pure module — no side effects beyond file I/O

**Decision**: The evidence-bundle module does not call `gh`, does not post comments itself, and does not read config. The orchestrator (`pipeline.ts`) owns the notification comment after calling `finalizeBundle()`. This keeps the module testable in isolation.

## Risks / Trade-offs

- **File I/O in the hot path**: every stage now does one extra read-modify-write. The bundle is small (<10 KB) and local disk I/O is fast; the latency is negligible compared to harness invocations and GitHub API calls.
- **Crash during rename leaves `.tmp` file**: an orphaned `.tmp` file is harmless — the next run overwrites it. No cleanup is needed.
- **Partial runs produce partial bundles**: intentional and useful (shows where the run stopped). The `finalState` field is `null` until `finalizeBundle()` is called, making partiality detectable.
- **Re-runs within the same issue overwrite the bundle**: the bundle path is `evidence.json` (not run-stamped). A second run on the same issue starts fresh. Historical runs are not retained by default. This is acceptable given the non-goal of full transcript capture; git history and GitHub comments preserve the historical record.

## Open Questions

None. The issue's acceptance criteria and non-goals resolve all key decisions.
