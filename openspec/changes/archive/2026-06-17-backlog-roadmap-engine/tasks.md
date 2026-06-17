## 1. CLI dispatch wiring

- [x] 1.1 Add `roadmap` to the recognized no-issue-number keyword list in `pipeline.ts`; detect it in the dispatch block alongside `release`, `intake`, `init`, etc.
- [x] 1.2 Add `--apply` flag and `--next <N>` option to the commander definition; thread `--dry-run` through.
- [x] 1.3 Update the `.argument(...)` description string and help text to list `roadmap` alongside peer sub-commands.
- [x] 1.4 Import `runRoadmap` from `./roadmap/index.ts` and add the early dispatch call (before config resolution, mirroring the `release`/`intake` pattern).

## 2. Config schema extension

- [x] 2.1 Add `roadmap` block to `PartialConfigSchema` in `config.ts` with fields: `include_labels` (string[]), `exclude_labels` (string[]), `score_weights` (object with optional `impact`, `confidence`, `ease`, `risk_reduction`, `dep_leverage` number overrides), `hygiene_auto_apply` (boolean, default false), `pr_docs` (boolean, default true).
- [x] 2.2 Add unit test verifying the `roadmap:` block is accepted and defaults resolve correctly; verify `roadmap:` with unknown keys triggers a strict-schema parse error.

## 3. `gh.ts` multi-issue wrappers

- [x] 3.1 Add `getOpenIssues(repo, opts?: { labels?: string[] }): Promise<Issue[]>` using `gh issue list --json number,title,body,labels,url,state` — confirm exact `--json` field names with `gh issue list --json` before coding.
- [x] 3.2 Add `createMilestone(repo, title, dueOn?: string): Promise<number>` and `getMilestones(repo): Promise<Milestone[]>` — confirm `gh api` field shapes before coding.
- [x] 3.3 Add unit tests for each wrapper using the `GhDeps` fake pattern (no real subprocess calls).

## 4. Prompt templates

- [x] 4.1 Author `core/scripts/prompts/roadmap-comprehend.md` with `{{repo_name}}`, `{{recent_commits}}`, `{{open_issue_count}}`, `{{file_tree}}` placeholders; output: repo architecture summary, engineering system notes, recent churn hotspots, product intent.
- [x] 4.2 Author `core/scripts/prompts/roadmap-depverify.md` with `{{issue_a}}`, `{{issue_b}}`, `{{file_contents}}` placeholders; output: `{ edge_confirmed: bool, file_line: string, rationale: string }`.
- [x] 4.3 Author `core/scripts/prompts/roadmap-critique.md` with `{{plan_json_excerpt}}`, `{{schema_block}}` placeholders; output matches `review-schema.ts` verdict schema (reuse `{{schema_block}}` injection).
- [x] 4.4 Register all three prompts in the prompts loader / index.

## 5. `inventory.ts`

- [x] 5.1 Define `InventoryDeps` interface: `getOpenIssues`, `readFile`, `log`.
- [x] 5.2 Implement `buildInventory(repo, config, deps): Promise<InventoryItem[]>` — fetches all open issues, applies `include_labels`/`exclude_labels` filter, reads code/docs/tests touched by each issue (via a comprehension harness call per issue batch), returns structured `InventoryItem[]` (issue metadata + `touched_files[]`).
- [x] 5.3 Unit tests: filter by labels; touched-files extraction; empty backlog returns `[]`.

## 6. `depgraph.ts`

- [x] 6.1 Define `DepgraphDeps` interface: `runHarness` (dep-verify prompt), `readFile`, `log`.
- [x] 6.2 Implement `buildDepgraph(items, deps): Promise<DepGraph>` — for each candidate pair emitted by the inventory, runs the `roadmap-depverify` harness call with the actual file content; only promotes edges confirmed with `file:line` to `must_precede` or `should_precede`.
- [x] 6.3 Implement `topoSort(graph): IssueNumber[][]` — returns dependency-adjusted tiers; on cycle detection populates `cycle_reports[]` and does NOT silently break cycles.
- [x] 6.4 Unit tests: happy path; cycle detection; `should_precede` vs `must_precede` classification; unverified candidate stays in `open_questions`.

## 7. `score.ts`

- [x] 7.1 Implement `scoreItems(items, graph, weights): ScoredItem[]` — applies `Priority = (Impact × Confidence × Ease) + RiskReduction + DepLeverage` with sub-factors 1–5 and optional weight overrides; `Ease = 5 - Effort` (1–5 scale).
- [x] 7.2 Implement `applyDepAdjustment(scored, topo): RoadmapTier[]` — produces tiered output (enablers → dependency-unlock → high-value/low-risk → larger bets → cleanup) respecting the topo-sort order; a dependent item MUST NOT appear before its `must_precede` prerequisite.
- [x] 7.3 Unit tests: formula correctness; weight override; dep-constraint preservation; tier assignment.

## 8. `writeback.ts`

- [x] 8.1 Define `WritebackDeps` interface: `writeFile`, `gitCreateBranch`, `gitCommit`, `createPr`, `createLabel`, `applyLabel`, `createMilestone`, `getMilestones`, `closeIssue`, `addComment`, `editIssue`, `createIssue`, `log`.
- [x] 8.2 Implement `writePlanJson(plan, outputDir, deps)` — writes `.agent-pipeline/roadmap/<repo>/plan.json`; content-addressed (includes `generated_at`, `backlog_sha`).
- [x] 8.3 Implement `writeRoadmapMd(plan, outputDir, deps)` — writes `.agent-pipeline/roadmap/<repo>/roadmap.md` with stable IDs and DONE-tracker section.
- [x] 8.4 Implement `openRoadmapPr(plan, deps)` — commits `roadmap.md` to `docs/roadmaps/<repo>.md` on a new branch; opens PR targeting default branch; skipped if `config.roadmap.pr_docs === false`.
- [x] 8.5 Implement `applyHygiene(hygiene[], deps)` — applies each hygiene action (close / add-comment / edit-title / new-issue) with content-addressed sentinel (`<!-- roadmap-run:<hash> -->`); pre-flight state check before each write; skipped if `!opts.apply`.
- [x] 8.6 Unit tests: idempotency (second call skips already-applied actions); dry-run produces no writes; `plan.json` round-trips through JSON.parse.

## 9. `roadmap/index.ts` — orchestrator

- [x] 9.1 Define `RoadmapDeps` (union of all sub-module deps + harness for comprehension + critique).
- [x] 9.2 Implement `runRoadmap(opts, config, deps)` — orchestrates the 7 phases in order: comprehend → inventory → depgraph → score → roadmap → hygiene → critique; critique corrections trigger a bounded re-sort (≤ 2 rounds) before promoting to `open_questions`.
- [x] 9.3 Implement `--next <N>` path: reads existing `plan.json`, warns if stale (age > 7 days or configurable threshold), emits top-N dependency-safe issues without re-running the engine.
- [x] 9.4 Unit tests: phase ordering; `--next` stale warning; `--next` with fresh plan; critique correction round triggers re-sort.

## 10. Adversarial critique integration

- [x] 10.1 Run critique using `review-schema.ts` verdict schema injected via `{{schema_block}}` — single-sourced, drift-guarded (existing test).
- [x] 10.2 Apply `partitionFindings` to classify critique findings as `blocking` vs `advisory` per `review_policy`.
- [x] 10.3 Dep-order violation findings are extracted and re-applied as additional `must_precede` edges; topo-sort re-runs; at most 2 correction rounds before promoting to `open_questions[]`.
- [x] 10.4 Unit test: critique finding triggers re-sort; second identical finding promotes to `open_questions`.

## 11. Unit tests (integration-level)

- [x] 11.1 End-to-end dry-run: phases 1–7 run; `plan.json` + `roadmap.md` written to output dir; no GitHub mutations.
- [x] 11.2 End-to-end `--apply`: hygiene actions called; PR opened; idempotency sentinel checked.
- [x] 11.3 `--next 3`: emits 3 dependency-safe issues from `plan.json`; no engine re-run.

## 12. Documentation

- [x] 12.1 Add `roadmap` to the sub-command table in `README.md` (flags, phases, output files, dry-run example).
- [x] 12.2 Add `roadmap` to `hosts/claude/SKILL.md` (usage line + example).

## 13. Mirror + CI

- [x] 13.1 `node scripts/build.mjs`; verify mirror is in sync.
- [x] 13.2 `npm run ci` green end-to-end.
