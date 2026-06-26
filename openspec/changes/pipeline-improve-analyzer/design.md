## Context

The pipeline writes structured run artifacts to `.agent-pipeline/runs/<run-id>/` for every dispatch cycle: `events.jsonl` (stage lifecycle + review verdicts + blockers), `summary.json` (terminal state), review-finding records, and override records. These exist today and are read by Pipeline Desk for display — they are not consumed for cross-run analysis.

The gap: when the same review finding recurs across ten issues, or the same gate blocks four consecutive runs, nobody sees the pattern as a whole. The evidence is there; the aggregation is missing.

## Goals / Non-Goals

**Goals:**
- Add `pipeline improve [--apply] [--top <N>] [--since <date>]` as a new CLI subcommand.
- Read across all (or windowed) run artifacts, cluster recurring patterns by category, and surface them as candidate improvement work.
- Default mode is dry-run: print a structured report, exit 0, write nothing.
- `--apply` mode creates GitHub issues via `gh issue create` for the top-N clusters; each issue body embeds source run IDs and evidence excerpts.
- Keep the implementation read-only except for the `--apply` flag.

**Non-Goals:**
- Auto-filing issues without `--apply` (no side effects by default).
- Mutating labels, branches, PRs, worktrees, repo files, or pipeline config under any flag.
- Acting on its own findings — the first version proposes, it does not fix.
- Real-time / streaming analysis; this is a batch read pass over existing artifacts.
- ML-based clustering — simple category + normalized-title frequency is sufficient for v1.

## Decisions

### 1. Cluster categories

Four named cluster categories, each with a distinct evidence source:

| Category | Evidence source | Signal |
|---|---|---|
| `review-finding` | `review_verdict` events, `.findings[]` in events.jsonl | Same normalized `title` recurs across runs |
| `blocker` | `blocker_set` events in events.jsonl | Same `reason` string recurs across runs |
| `flaky-gate` | `stage_complete` events with `outcome: "error"` | Same stage erroring repeatedly |
| `token-waste` | `summary.json` fields or `stage_complete` duration fields | Stages with anomalously high token or duration costs |

For v1, token-waste is best-effort (only if summary.json exposes token counts). If absent, the category is silently skipped rather than erroring.

**Rationale:** Named categories make the report actionable. An unlabeled "similar runs" cluster doesn't tell the maintainer what kind of problem to file. Four discrete categories also keep the clustering logic simple: normalize the signal string, count occurrences, rank by frequency.

### 2. Normalization strategy

Finding titles and blocker reasons are normalized by:
1. Lowercasing.
2. Stripping issue/PR/SHA/line-number tokens (patterns: `#\d+`, `[0-9a-f]{7,40}`, `:\d+`).
3. Collapsing whitespace.

Two records with the same normalized string are the same cluster. This avoids fragmenting "Finding X at line 42" and "Finding X at line 107" into separate clusters.

**Alternative considered:** Semantic / embedding-based clustering. Rejected for v1 — adds an external API dependency and significant complexity for marginal gain over normalized-title frequency on a small corpus.

### 3. Run discovery

Walk `.agent-pipeline/runs/*/events.jsonl` (globbed from the repo root). The `--since <date>` flag prunes runs whose `run.json` `started_at` predates the cutoff. If `run.json` is missing (crashed run), include the run anyway — events.jsonl alone is sufficient for clustering.

### 4. Output format

Dry-run prints a human-readable Markdown-ish report to stdout:
```
## Cluster: review-finding — "null check missing on worktree path"
Occurrences: 7  Runs: #12-456 #14-789 ...
Evidence: [excerpt from findings[0].body, truncated at 200 chars]
Proposed issue title: "review: 'null check missing on worktree path' recurs (7 runs)"
---
```
With `--json`, emit a machine-readable JSON array of cluster objects (for integration with Pipeline Desk).

### 5. Apply mode safety

`--apply` requires explicit invocation. The flag is not inferred from environment variables or config. Apply mode calls `gh issue create --title "..." --body "..."` for each cluster above the threshold. It does not open PRs, label existing issues, or touch worktrees. If `gh` is not authenticated, `--apply` exits with an error.

### 6. Module placement

`core/scripts/stages/improve.ts` is the wrong location — this is not a pipeline stage but a CLI subcommand. Place at `core/scripts/improve.ts` with a corresponding `improve` case in the `pipeline.ts` CLI dispatch table.

## Risks / Trade-offs

- **Stale run data** → Mitigation: `--since` flag lets the caller scope to recent runs; old noise doesn't pollute the report.
- **Token-waste category absent** → Mitigation: silently skip if summary.json lacks token fields; report notes "token-waste skipped (no token data)".
- **Large run corpus OOM** → Mitigation: stream events.jsonl line-by-line, accumulate only normalized keys and occurrence counts (O(distinct keys), not O(total events)).
- **False-positive clusters from prompt wording churn** → Trade-off: normalization reduces fragmentation but can over-merge distinct findings. Acceptable in v1; a fingerprint-aware approach can follow.
- **`--apply` creates duplicate issues if run twice** → Mitigation: document it; a dedup-by-title check against open issues is a follow-on improvement.

## Open Questions

- Should the `--json` output schema be single-sourced against a TypeScript type the way `review-schema.ts` sources the verdict schema? Likely yes — defer to implementation; flag it in tasks.
- What threshold (minimum occurrence count) should gate `--apply` issue creation? Proposed default: `--min-occurrences 3`.
