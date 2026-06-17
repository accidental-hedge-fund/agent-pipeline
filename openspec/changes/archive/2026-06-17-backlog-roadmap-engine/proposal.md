## Why

"Analyze this repo + backlog and give me an ordered, dependency-aware plan" is a recurring, high-value workflow that is currently done ad hoc — one issue at a time, with no explicit dependency ordering, scoring, or hygiene step. The pipeline is rigorously single-issue today; this adds the missing *many-issues-at-once* layer on top of mature single-issue primitives, realizing the existing ROADMAP.md item #158 (Intake & backlog automation, v1.6.0).

## What Changes

- Add `roadmap` as a new no-issue-number positional sub-command keyword in the pipeline CLI (alongside `intake`, `init`, `doctor`, `release`).
- Add `core/scripts/roadmap/` module with sub-components: `inventory.ts` (multi-issue fetch + code-touch analysis), `depgraph.ts` (dependency-graph construction + source verification + topological ordering + cycle handling), `score.ts` (formula-based scoring + dependency-adjusted ordering), `writeback.ts` (plan.json + roadmap.md generator, GitHub hygiene mutations, new-issue drafts).
- Add prompt templates: `prompts/roadmap-comprehend.md`, `prompts/roadmap-depverify.md`, `prompts/roadmap-critique.md`.
- Add `roadmap:` block to the Zod config schema (`config.ts`).
- Output contract: `.agent-pipeline/roadmap/<repo>/plan.json` (machine source of truth) + `roadmap.md` (human living-doc, PR'd into `docs/roadmaps/`).
- `--apply` flag gates all GitHub write-back (labels, milestones, comments, issue mutations, new-issue creation, hygiene close/merge/rewrite); omitting it runs as dry-run.
- All logic is behind DI `RoadmapDeps` seams; unit tests use fakes with no real network, git, or subprocess calls.
- Reuse existing primitives: `harness.ts` + `prompts/substitute()` (comprehension + dep-verification passes), `review-schema.ts` / `partitionFindings` / `findingKey` (adversarial critique), `worktree.ts` + `createPr` (roadmap-doc PR), `evidence-bundle.ts` (write-back provenance).
- Net-new GitHub API wrapper: `getOpenIssues` via `gh issue list --json` (none exists today), milestone creation/lookup wrapper.

## Capabilities

### New Capabilities
- `backlog-roadmap-engine`: The `roadmap` no-issue-number sub-command: CLI dispatch, 7-phase engine (comprehend → inventory → depgraph → score → roadmap → hygiene → critique), `plan.json` + `roadmap.md` output contract, `--apply` write-back gate, idempotent GitHub mutations, DI seam + unit tests.

### Modified Capabilities
- `pipeline-state-machine`: The CLI positional-argument dispatch block gains `roadmap` as a recognized keyword that requires no issue number, does not advance any stage label, and MUST be listed in the help text alongside other no-issue-number modes.

## Impact

- `core/scripts/pipeline.ts` — dispatch block, help text, flag definitions (`--apply`, `--next <N>`).
- `core/scripts/roadmap/` — new module (inventory, depgraph, score, writeback), each with injectable deps.
- `core/scripts/config.ts` — `roadmap:` block added to `PartialConfigSchema` (Zod).
- `core/scripts/gh.ts` — `getOpenIssues`, `createMilestone`, `getMilestones` wrappers added.
- `core/scripts/prompts/` — three new prompt templates (comprehend, depverify, critique).
- `core/test/roadmap-*.test.ts` — unit tests for each sub-module.
- `.agent-pipeline/roadmap/<repo>/plan.json` + `roadmap.md` — runtime output artifacts (gitignored or PR'd).
- `plugin/` mirror — regenerated after any `core/` change.
- `README.md` / `hosts/claude/SKILL.md` — document the new sub-command.

## Acceptance Criteria

- [ ] `pipeline roadmap` (with no issue number) is accepted by the CLI and dispatched without requiring an issue number; it is listed in help text alongside peer sub-commands.
- [ ] Phase 1 (comprehend) always runs and reads the repo's architecture, engineering system, recent churn, and product intent before any ranking or scoring.
- [ ] Phase 2 (inventory) fetches every open issue in full and identifies the code/docs/tests each issue touches — titles alone are not trusted.
- [ ] Phase 3 (depgraph) builds a dependency graph from source-verified edges (each edge cites file:line evidence); no dependent precedes its hard prerequisite in the final order; cycles are detected and reported rather than silently broken.
- [ ] Phase 4 (score) applies the formula `Priority = (Impact × Confidence × Ease) + RiskReduction + DepLeverage` with sub-factors 1–5; every score is reproducible from the formula given the same inputs; Ease = inverse-effort.
- [ ] Phase 5 (roadmap) produces a tiered plan: enablers → dependency-unlock → high-value/low-risk → larger bets → cleanup; each item includes rank, score breakdown, dep rationale, files, effort (XS–XL), and risks.
- [ ] Phase 6 (hygiene) proposes close/merge/rewrite/split/spike/postpone for each candidate with exact comment text and file:line evidence; no mutation is applied without `--apply`.
- [ ] Phase 7 (adversarial critique) always runs; it attacks for dep-order violations, non-reproducible scores, missed duplicates, and mislabeled "ready" issues; corrections are applied to the plan before finalization.
- [ ] `plan.json` is the machine source of truth: contains `dependency_graph`, `scored[]`, `roadmap[]`, `hygiene[]`, `milestones[]`, `new_issue_drafts[]`, `critique[]`, and `open_questions[]`; downstream "next N" and re-runs are derived from it, never re-derived by an LLM.
- [ ] `roadmap.md` is a human living-doc with stable IDs and a DONE-tracker section; it is committed on a new branch and a PR is opened targeting the default branch.
- [ ] `--apply` gates all GitHub write-back (label/milestone/comment/issue mutations); omitting `--apply` runs as dry-run and prints the intended mutations without touching GitHub.
- [ ] Write-back is idempotent: re-runs create no duplicate labels, milestones, comments, or issues.
- [ ] `--next <N>` emits the top-N directly pipeline-able issues (in dependency-safe order) derived from `plan.json` without re-running the engine.
- [ ] All new logic is covered by unit tests using injectable deps (no real network, git, or subprocess in tests); `npm run ci` passes end-to-end after the change.
- [ ] A maintainer can act on the output without another triage pass: every "ready" issue is source-verified, every dep edge cites file:line, every score is reproducible, and the "next N" list is directly pipeline-able.
