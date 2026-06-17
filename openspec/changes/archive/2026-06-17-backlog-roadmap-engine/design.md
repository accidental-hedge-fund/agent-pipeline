## Context

The pipeline today is rigorously single-issue: every primitive (harness, review, worktree, evidence-bundle, depgraph-from-code) operates on one issue number at a time. The `intake` sub-command (#158 / PR #205) introduced a no-issue-number dispatch path and the ROADMAP.md mutation primitives. The `backlog-roadmap-engine` adds the first *multi-issue* operating mode on top of those mature primitives.

Key constraints carried forward:
- No auto-merge; no new external runtime dependencies; all I/O is injectable via `Deps` seams.
- The engine is the data layer; Pipeline Desk is the presentation layer — the seam is `plan.json`.
- Rigor over latency (CLAUDE.md §3): the comprehension and adversarial-critique phases always run.

## Goals / Non-Goals

**Goals:**
- Add `roadmap` as a no-issue-number sub-command using the existing dispatch pattern.
- Produce a `plan.json` machine source of truth and a `roadmap.md` human living-doc, both under `.agent-pipeline/roadmap/<repo>/`.
- All 7 phases always run (no shortcuts for small backlogs).
- `--apply` is the single gate for all GitHub write-back; omitting it is dry-run.
- Write-back is idempotent across re-runs.
- Reuse: `harness.ts`, `review-schema.ts`, `partitionFindings`, `findingKey`, `worktree.ts`, `createPr`, `evidence-bundle.ts`, `prompts/substitute()`.

**Non-Goals:**
- The GUI (cockpit) — lives in pipeline-desk companion issue.
- Executing the ordered issues — that is the existing `/pipeline`; this only orders them and emits the queue.
- Replacing or wrapping `/sweep` or `/pm` — those are distinct skills.
- Auto-ordering based on LLM re-derivation at "next N" time — `plan.json` is the frozen source of truth; "next N" is a deterministic read.
- Interactive prompting — the command is non-interactive; all inputs are flags.

## Decisions

**Decision: `plan.json` as the frozen engine→cockpit seam.**
The engine runs phases 1–7 and writes `plan.json` once. All downstream derivations ("next N to pipeline", desk graph, re-runs that skip re-analysis) read `plan.json` deterministically. An LLM never re-derives the order from prose — scores are numeric fields, dep edges carry `file:line` citations, and hygiene dispositions are enum values. This makes the seam auditable, diffable, and cockpit-renderable without an additional LLM call.

**Decision: Source-verified dependency edges only.**
Dep edges in `plan.json` are allowed only when the engine has read the relevant source file and identified the actual coupling (a type import, a shared config key, a data migration predecessor, etc.) — not from reading issue text. Edges with only textual evidence are flagged in `open_questions[]`, not promoted to `must_precede`. This eliminates phantom deps that have caused non-converging review rounds in the past.

**Decision: Reuse `review-schema.ts` / `partitionFindings` / `findingKey` for the adversarial-critique phase.**
The critique is structurally identical to a code review: a bounded-round adversarial pass with content-addressed finding keys, `block_threshold`-governed convergence, and `partitionFindings` output. Reusing the single-sourced schema and the existing `findingKey` fingerprint prevents a new parallel finding-identity system (which would reintroduce override-key churn, lesson from memory).

**Decision: `--apply` gates ALL write-back; no partial-apply flags.**
Partial-apply flags (`--apply-hygiene`, `--apply-milestones`) would complicate idempotency guarantees and make the "preview first" contract confusing. The single `--apply` flag keeps the interface simple: dry-run (default) shows everything; `--apply` executes everything. Re-runs are idempotent regardless of which actions have already been applied.

**Decision: `getOpenIssues` is a new wrapper around `gh issue list --json`.**
No multi-issue fetch exists today. Rather than parsing raw `gh` output in the engine, a typed wrapper `getOpenIssues(repo, opts): Promise<Issue[]>` is added to `gh.ts` alongside the existing typed wrappers, keeping the boundary consistent and unit-testable via the `GhDeps` fake pattern.

**Decision: Topological order computed in `depgraph.ts`, not in `score.ts`.**
Scoring is pure (numeric formula, no graph traversal). Ordering requires the topological sort. Keeping them separate allows scores to be computed in parallel across all issues, then ordering applies the topo-sort as a post-pass. Cycles are detected in `depgraph.ts` and surface in `plan.json.dependency_graph.cycle_reports[]` rather than silently broken.

**Decision: `roadmap:` config block in Zod schema, not a top-level CLI flag cluster.**
Per the existing config pattern (all tunables in `.github/pipeline.yml` under a sub-key), roadmap tunables (`include_labels`, `exclude_labels`, `score_weights`, `hygiene_auto_apply`) live under `roadmap:` in Zod. CLI flags (`--apply`, `--next`) are action selectors, not config. This keeps the CLI surface minimal.

## Risks / Trade-offs

- *Phase 2 cost (full issue + code read)* → For repos with hundreds of open issues, the inventory phase requires many file reads. Mitigation: the engine reads code only for issues that survive an initial relevance filter (open + not stale-closed candidate); the harness compresses context. No cap is imposed silently — if the inventory is bounded, `plan.json.open_questions[]` MUST record it.
- *Dep-edge source verification latency* → Verifying each candidate dep edge with a file read adds wall-clock time. Mitigation: verification calls run concurrently via `harness.ts` (existing parallel harness support); the spec requires per-edge `file:line` citation, not per-edge sequential verification.
- *Adversarial critique may find dep-order violations after topological sort* → The critique can surface errors the sort missed (e.g., implicit runtime deps not captured in code imports). Mitigation: critique findings that dispute dep order are re-applied as additional `must_precede` edges and the sort re-runs; this is bounded (at most 2 correction rounds) before the critique findings are promoted to `open_questions[]`.
- *Idempotency of GitHub hygiene mutations* → Re-running `--apply` twice must not double-post comments or double-close issues. Mitigation: each write-back action is content-addressed (comment body includes a `<!-- roadmap-run:<hash> -->` sentinel; close actions check current state before acting); the spec's idempotency requirement is enforced by `writeback.ts` pre-flight checks.
- *`plan.json` staleness* → If the backlog changes significantly after a run, `plan.json` is stale. Mitigation: `plan.json` includes a `generated_at` timestamp and a `backlog_sha` fingerprint; the `--next` command warns if the age exceeds a configurable threshold (default 7 days). Re-running the full engine refreshes it.

## Open Questions

- Should `roadmap.md` be committed directly into the repo (under `docs/roadmaps/`) via a PR, or written only to `.agent-pipeline/roadmap/<repo>/` (gitignored)? Current decision: both — the machine-readable `plan.json` is gitignored; the human `roadmap.md` is PR'd into `docs/roadmaps/`. This can be config-gated (`roadmap.pr_docs: false` to skip the PR).
- Milestone creation: creating GitHub milestones requires `milestone` scope. If the token lacks it, `writeback.ts` MUST skip milestone creation and surface a warning in `plan.json.open_questions[]`, not fail the run.
