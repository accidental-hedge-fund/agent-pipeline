## Context

The pipeline produces commits from two distinct paths:

1. **Direct pipeline commits**: `gitInWorktree(wt.path, ["commit", "-m", msg])` calls in `pre_merge.ts` and `planning.ts`. The pipeline owns the entire commit command — modifying these is straightforward.

2. **Harness-instructed commits**: Claude or Codex is told via prompt templates (e.g., `implementing.md`, `fix.md`) to "commit your changes." The agent writes the commit command; the pipeline cannot inspect or modify it after the fact.

Neither path currently produces trailers. There is no pipeline run ID concept.

## Goals / Non-Goals

**Goals:**
- Every commit produced during a pipeline run carries `Issue:` and `Pipeline-Run:` trailers.
- All commits from a single run carry the _same_ `Pipeline-Run:` value (enabling per-run grep).
- Direct pipeline commits are guaranteed to have trailers (code-level enforcement).
- Harness commits are instructed to have trailers via prompt (best-effort — agents follow instructions).

**Non-Goals:**
- Post-hoc rewriting of existing commits to add trailers.
- Enforcement that the agent-produced commit message has correct trailers (verification belongs in a separate audit step, not this change).
- Trailer values that are actionable links (e.g., deep GitHub URLs) — plain identifiers are enough.

## Decisions

### D1: Trailer key names

**Decision**: Use `Issue` and `Pipeline-Run` as trailer keys.

```
Issue: #42
Pipeline-Run: 42/2026-06-08T14:32:00Z
```

`Issue` is consistent with the momentiq convention cited in the issue (momentiq uses `Issue:` trailers). `Pipeline-Run` is self-descriptive and namespaced to avoid conflicts with generic `Run:` keys that some CI systems write. Both are greppable: `git log --grep="^Issue: #42"`.

**Alternative considered**: `Pipeline-Issue:` / `Pipeline-RunId:`. Rejected: more verbose than needed; `Issue:` already exists in external conventions.

### D2: Run ID derivation

**Decision**: Generate the run ID as `<issueNumber>/<UTC-ISO-timestamp>` at the start of the pipeline dispatch for that issue (e.g., `42/2026-06-08T14:32:00Z`). Format: `<number>/<YYYY-MM-DDTHH:MM:SSZ>`.

This is deterministic, human-readable, contains the issue number for redundancy, and requires no external storage. Because it is generated once per dispatch and passed into every subsequent operation, all commits from the same run carry the same value.

**Alternative considered**: UUID or short random hash. Rejected: opaque, requires lookup to associate with an issue; the issue-prefixed timestamp is self-explanatory in a `git log`.

**Alternative considered**: Using the git branch name as the run ID. Rejected: the branch name does not change between runs (if the pipeline is re-triggered on the same branch), so two separate runs would be indistinguishable.

### D3: Threading the run ID

**Decision**: Generate `pipelineRunId` in the orchestrator entry point (before any stage dispatch) and pass it as a parameter to stage functions that create commits. Add it as a field to the `invoke()` call args so harness prompts can receive it via template substitution.

This keeps the run ID as pure data flowing down the call stack — no global state, no re-generation per stage.

### D4: Harness trailer injection approach

**Decision**: Update `implementing.md`, `fix.md`, and `test_fix.md` to instruct the agent to add trailers using standard git trailer syntax in the commit message body:

```
<subject line>

Issue: #{{issue_number}}
Pipeline-Run: {{pipeline_run_id}}
```

Agents (Claude/Codex) already follow the `Co-Authored-By:` trailer convention established by Claude Code. Adding two more trailers to the same commit pattern is a minimal, well-understood instruction.

**Alternative considered**: Use `git commit --trailer` flag instead of message-body trailers in harness prompts. Rejected: harness agents write commit commands in natural language; `--trailer` flag is less universally known and harder to include correctly from a prompt. Message-body trailers are parsed identically by `git interpret-trailers`.

### D5: Direct commit modification

**Decision**: Replace `["commit", "-m", msg]` with `["commit", "-m", `${msg}\n\nIssue: #${issueNumber}\nPipeline-Run: ${pipelineRunId}`]` for all three direct commit sites.

This is simpler than threading `--trailer` flags (which require separate array entries per trailer and git 2.15+, though that's already assumed). Both approaches produce identical trailer-parsed output.

## Risks / Trade-offs

- **Agent non-compliance**: A harness agent may omit or malform the trailers. Mitigation: this change makes trailers a stated requirement in the prompt; non-compliance is a model quality issue tracked separately, not a pipeline failure.
- **Multi-line commit messages**: If an agent already writes a multi-line commit message, appending trailers to it may or may not be git-valid depending on blank-line separators. The prompt instructs the agent to place trailers at the bottom, separated by a blank line from the body — standard git trailer format.
- **Timestamp precision**: Two runs in the same second on the same issue get the same `Pipeline-Run:` value. This is astronomically unlikely in practice and acceptable for audit purposes.

## Open Questions

None. The scope is narrow (metadata only), the patterns are established, and the decisions above cover all branching points.
