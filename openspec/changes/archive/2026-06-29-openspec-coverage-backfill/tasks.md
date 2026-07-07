## 1. CLI dispatch wiring

- [ ] 1.1 Add `backfill` to the recognized no-issue-number keyword list in `pipeline.ts` (the `recognized` array) and add an `isBackfillCommand = numArg === "backfill"` detector alongside `isSweepCommand`/`isIntakeCommand`.
- [ ] 1.2 Add `--apply`, `--capability <name>`, and `--repo <owner/repo>` options to the commander definition; thread them to the handler. `--apply` defaults to false (preview).
- [ ] 1.3 Update the `.argument(...)` description string and `--help` text to list `backfill` alongside peer no-issue-number sub-commands.
- [ ] 1.4 Add the early dispatch block: resolve config, then `import { runBackfill, realBackfillDeps } from "./stages/backfill.ts"` and call it (mirroring the `sweep` dispatch). Reject `--apply` with no resolvable slice as a usage error.

## 2. Behavior-analysis prompt

- [ ] 2.1 Author `core/scripts/prompts/backfill.md` with placeholders for the repo context, the living-spec requirement inventory, and the evidence corpus (tests/docs/code/history summaries). The prompt instructs the model to enumerate candidate accepted behaviors, draft each as a requirement (user-visible behavior + provenance), and grade evidence as sufficient / conflicting / uncertain.
- [ ] 2.2 Register the prompt in `core/scripts/prompts/index.ts` via the existing template-render path, with a placeholder-validation test.

## 3. Coverage comparison (deterministic)

- [ ] 3.1 Add a pure `classifyCoverage(candidates, livingRequirements, openBackfillRequirements)` helper (in `openspec.ts` or `backfill.ts`) that assigns each candidate to `already-covered` / `missing-coverage` / `conflicting-evidence` / `uncertain-evidence`, using behavior identity (not verbatim prose) for already-covered/already-proposed matching.
- [ ] 3.2 Ensure coverage is computed from living-spec *content* (requirement inventory), never from `isInitialized` — a partially-populated workspace still yields missing candidates.
- [ ] 3.3 Unit-test `classifyCoverage`: empty/absent workspace → everything is a candidate; partial workspace → only uncovered behaviors are missing; a candidate contradicting a living requirement → conflicting; a candidate already in an open backfill change → already-proposed (skipped).

## 4. `BackfillDeps` interface and `realBackfillDeps()`

- [ ] 4.1 Define `BackfillDeps` in `backfill.ts`: `runHarness`, `readLivingSpecs`, `readEvidenceCorpus`, `validate`, `writeFile`, `gitCreateBranch`, `gitCommit`, `createPR`, `log`.
- [ ] 4.2 Implement `realBackfillDeps()` wiring each dep to the real harness / `openspec.ts` / filesystem / `gh` wrappers.

## 5. `runBackfill` handler — preview path (default)

- [ ] 5.1 Resolve the target repo/workspace; read the living-spec requirement inventory and any open backfill change/PR.
- [ ] 5.2 Invoke the behavior-analysis harness (single model call) to draft graded, provenance-bearing candidates.
- [ ] 5.3 Run `classifyCoverage` to assign the four groups.
- [ ] 5.4 Print the grouped report: per-group items with provenance, aggregate counts, skipped items, conflicts, and a concise "what to review next" summary.
- [ ] 5.5 End the preview with an explicit "no specs, issues, branches, or PRs were changed" statement. Make no writes of any kind in this path.

## 6. `runBackfill` handler — apply path (`--apply`)

- [ ] 6.1 Select the slice: the `missing-coverage` candidates, scoped by `--capability` when supplied. Abort with a usage error if the slice is empty.
- [ ] 6.2 Author an OpenSpec change under `openspec/changes/<backfill-id>/`: `proposal.md`, `tasks.md`, and `## ADDED Requirements` deltas for the slice. Each requirement carries its provenance and a backfill annotation distinguishing accepted-existing from new-intended behavior.
- [ ] 6.3 Assert the authored diff touches only paths under `openspec/`; abort before any PR if a non-`openspec/` path would change.
- [ ] 6.4 Run `openspec validate` on the authored change; on failure, abort with an actionable blocker naming the validation error and report NO success (no PR).
- [ ] 6.5 Create a branch (e.g. `backfill/<capability-or-slug>`), commit the change, and open a PR targeting the default branch via `deps.createPR`. Never commit directly to the default branch; never merge.
- [ ] 6.6 Print the apply report (slice contents, validation result, PR URL) and the same scale-aware summary.

## 7. Idempotency

- [ ] 7.1 On re-run, recognize behaviors already present in living specs as `already-covered` and behaviors already in an open backfill change/PR as `already-proposed`; propose neither again.
- [ ] 7.2 Unit-test idempotency: a second apply over the same repo state produces an empty slice and reports the prior behaviors as covered/proposed.

## 8. Unit tests (`core/test/backfill.test.ts`)

- [ ] 8.1 Preview against absent / empty / partial workspaces: report produced, four groups present, no writes, "nothing changed" line present.
- [ ] 8.2 Partial-adoption: a workspace with some specs still surfaces uncovered behavior (not reported complete).
- [ ] 8.3 Every candidate has a user-visible-behavior label and ≥1 provenance reference; a candidate lacking provenance lands in `uncertain-evidence`.
- [ ] 8.4 Conflicting / uncertain candidates are excluded from the slice and listed for human decision.
- [ ] 8.5 Apply happy path: change authored, diff is `openspec/`-only, `validate` passes, branch + PR opened, no direct commit to default.
- [ ] 8.6 Apply with validation failure: blocker surfaced, no PR opened, non-zero exit.
- [ ] 8.7 Spec-only guard: a candidate that would touch a non-`openspec/` path aborts before the PR.
- [ ] 8.8 Idempotent re-run: empty slice, prior behaviors reported covered/proposed, no duplicate requirement.
- [ ] 8.9 Single model boundary: exactly one harness call; comparison, authoring, validation, and PR creation use no model.

## 9. Documentation

- [ ] 9.1 Add `backfill` to the sub-command table in `README.md` (flags, preview/apply, `--capability`, `--repo`, examples).
- [ ] 9.2 Add an operator section explaining when to use backfill, how to review provenance, how partial adoption is handled, and why low-confidence behavior is not auto-codified.
- [ ] 9.3 Add `backfill` to `hosts/claude/SKILL.md` (usage line + example).

## 10. Mirror + CI

- [ ] 10.1 `node scripts/build.mjs`; verify the `plugin/` mirror is in sync (`--check`).
- [ ] 10.2 `npm run ci` green end-to-end (including `openspec validate --all`).
