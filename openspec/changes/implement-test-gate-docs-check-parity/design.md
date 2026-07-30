## Context

Issue #716 is a factory-reliability follow-up to the #597 / PR #711 failure class:

1. Implement + test-gate advertised success and opened a PR.
2. Core unit tests were green (~5635 pass).
3. GitHub Actions `npm run ci` failed only on `generate-docs --check: stale generated docs: CHANGELOG.md`.
4. Pre-merge blocked with `ci-exhausted` / human intervention.

On this repo, `test_gate.command` is already `"npm run ci"` (`test-gate-ci-parity`). The #597 line of work wires:

- `docs:generate` → `node scripts/generate-docs.mjs`
- `docs:check` → `node scripts/generate-docs.mjs --check`
- `ci` chain includes `npm run docs:check` after the plugin mirror check

So **CI parity via the full `ci` script is necessary but not sufficient**. Stale generator outputs can still escape if implement "succeeds" with green unit tests, the fix harness never regenerates outputs, `docs:check` is dropped from `ci` while the generator remains, or a regenerate dirties the tree without a commit. This change hardens the **generic pre-PR worktree path** so stale generated docs cannot reach pre-merge as the first discovery site — for **any** consumer repo that ships the detected generator, not only agent-pipeline's `package.json`.

## Goals / Non-Goals

**Goals:**

- Explicit, single pre-PR sequence owned by the post-implementation path: finalize implement commits → format/test convergence → **docs freshness (check → optional auto-heal → re-check → re-run gates on new HEAD if committed)** → only then push / create-or-reuse PR → advertise implement success.
- Presence-based activation in the engine (worktree detection). Consumer repos with a detected generator get the same protection; generator-absent repos remain fully inert.
- Deterministic, safe auto-heal (clean-tree attribution, one bounded attempt, generator-only dirt) or fail closed with real diagnostics from check output.
- Block **both** new-PR creation and push/update of an existing PR branch while docs check is red.
- Drift-guard this repo's `ci` wiring when the generator is present; strengthen implement prompt language via pre-implement detection (not a post-hoc diff).
- Prove with seam-based regressions that push/`createPr` do not run when docs check is red.

**Non-Goals:**

- Hand-fixing #597 / PR #711.
- Making CHANGELOG generation fully environment-invariant beyond what #597 specifies.
- Replacing human CI for non-docs failures.
- Loop resume stranding (#712) or OpenSpec archive skip-then-block (#714).
- New config knobs / always-on gates for repos without a generator.
- Auto-merge or weakening review rigor.
- Hand-editing `plugin/` (always regenerate via `node scripts/build.mjs`).

## Decisions

### D1 — Activation is presence-based, not a new pipeline.yml flag

**Decision:** Treat a worktree as **docs-generator-present** only when:

1. `scripts/generate-docs.mjs` exists under the worktree root, **or**
2. root `package.json` defines a `docs:check` script whose value invokes that generator (contains `generate-docs.mjs` or an equivalent `node scripts/generate-docs… --check` form).

Do **not** activate on an arbitrary `docs:check` npm script that does not invoke this generator contract. When not present, all docs-freshness behaviors are no-ops (no generate/check, no docs auto-heal commits, no extra pre-PR blocks).

**Why:** Matches conditional OpenSpec CI validation. Avoids forcing every consumer to configure a docs gate. Avoids false activation on unrelated scripts named `docs:check`.

### D2 — Single pre-PR ordering and owner (generic worktree path)

**Decision:** Own enforcement in the shared post-implementation path used for first open **and** resume — primarily `resumeFromImplementing` in `core/scripts/stages/planning.ts` (gates → push → create-or-find PR), and the analogous post-fix path in `core/scripts/stages/fix.ts` when that path can also push an updated head.

**Canonical order after implement (or fix) commits are finalized:**

1. Existing format + test gates to convergence (`runFormatAndTestGates`).
2. **Docs freshness step** (only if docs-generator-present):
   1. Snapshot / require a **clean** worktree (same precondition class as `includeBuildArtifacts` in `build-side-effects.ts`).
   2. Run docs check (`npm run docs:check` if defined, else `node scripts/generate-docs.mjs --check`).
   3. If exit 0 → continue.
   4. If non-zero → **one** auto-heal attempt when eligible (D3); else fail closed (D4).
   5. After a successful heal commit: **re-run format+test gates on the new HEAD** (the heal must not ship untested / unformatted).
   6. Final docs check must be green before leaving this step.
3. Only then: `git push` and `createPr` / existing-PR reuse.
4. Only then: transition / advertise implement success.

A red docs check **must prevent both** `createPr` **and** treating push/reuse as a successful gate pass (no advancing past implement verification with a red-docs head).

**Why:** Reviewer-required single owner and ordering. Enforcement lives in the engine's generic path so consumer repos with a detected generator are protected even if they never wire `docs:check` into a full `npm run ci`. On agent-pipeline, including `docs:check` in `ci` remains the **certification spine** for `test_gate.command` parity; the dedicated step provides auto-heal + fail-closed diagnostics and covers generator-present consumers whose test command is only unit tests.

### D3 — Auto-heal is safe, deterministic, and bounded

**Decision:** Auto-heal runs **at most once** per post-implementation / post-fix gate pass when:

- worktree is docs-generator-present,
- initial docs check is non-zero,
- worktree is **clean** immediately before generate (precondition),
- write-mode command is available (`npm run docs:generate` if defined, else `node scripts/generate-docs.mjs`).

Procedure:

1. Run generate (write mode); capture stdout/stderr.
2. If generate exits non-zero → fail closed with generator error (do not invent stale file names).
3. If generate exits 0 and tree still clean → fail closed using **original** check output (and extracted stale paths if present).
4. If generate dirties the tree → stage and commit **only** the post-generate dirt (attributable because of the clean precondition), with message like `docs: regenerate generated docs (#N)` including the issue reference. Prefer a **new** conventional commit (not amend of implementer intent) so the heal is visible; do not amend unless an existing same-round convention requires it and tests lock that choice.
5. Re-run docs check. If still red → fail closed with re-check output + extracted stale paths.
6. If green → re-run format+test gates on new HEAD; any gate failure fails closed as today.

**Never** auto-commit when the worktree was dirty before generate (unrelated implementer dirt). Never commit non-generator dirt under a "docs regenerate" message. Fail closed if attribution, generation, commit, or re-check fails.

**Why:** Mirrors `build-side-effects.ts` clean-tree attribution (`includeBuildArtifacts` returns `{ ran: false }` on pre-existing dirt rather than sweeping unrelated paths). Bounded to one attempt so the stage cannot loop on non-deterministic generate.

### D4 — Fail closed with implementable diagnostics

**Decision:** Preserve full docs-check (and generate) stdout/stderr in the block reason (truncated with the shared head+tail helper, same class as build/test gate output). Parse listed stale paths from known generator output shapes (e.g. lines under `stale generated docs:` / bullet paths like `CHANGELOG.md`) when present. If the failure is **not** a parseable stale-output report, surface the command failure clearly **without** claiming file names that were not in the output.

Block reason must make clear that PR open/update was withheld for docs freshness.

### D5 — Prompt applicability is pre-implement, detection-based

**Decision:** Do **not** condition the regenerate instruction on a post-implementation diff of "touched paths" (that diff does not exist when the prompt is built).

Applicability:

- If worktree is **docs-generator-present** and `cfg.steps.docs` is enabled → extend the implementing docs section to require regenerate + commit of **all** generator outputs in the same change as generator/source edits, and name `npm run docs:check` / `node scripts/generate-docs.mjs --check`.
- If generator absent → keep existing hand-maintained docs instruction only; do not invent non-existent commands.
- Docs-primary issues (e.g. #597-class) are covered when `steps.docs` is on and the generator is present; the engine gate still enforces even if the model ignores the prompt.

**Why:** Prompt is built in `buildImplementingPrompt` before code exists. Presence + `steps.docs` is available at that time (same pattern as `docsEnabled` in `prompts/index.ts`).

### D6 — CI spine + drift-guard for this repo (`test-gate-ci-parity`)

**Decision:**

1. When `scripts/generate-docs.mjs` is present in this repository, root `package.json` MUST define `docs:check` / `docs:generate` and include the check in the `ci` script (after mirror check or equivalent documented position).
2. Drift-guard test **structurally** parses root `package.json` (JSON parse, inspect `scripts.ci` / transitive script graph for `docs:check` or `generate-docs.mjs --check`) — not a brittle whole-file substring assertion alone. Guard is conditional on generator file presence.
3. README / CLAUDE.md / AGENTS.md build guidance name docs freshness as part of `npm run ci` when the generator is present.

This remains **agent-pipeline-local** wiring. Engine enforcement (D2) protects consumers; the `ci` drift-guard protects this factory's own gate parity.

### D7 — Tests: injectable seams; prove bite; cover both PR surfaces

**Decision:** New module (e.g. `core/scripts/docs-freshness.ts`) + wiring tests with injectable deps: detect, runCheck, runGenerate, git status/add/commit, re-run gates. No real network/git/subprocess as the sole pass path in unit tests.

Required cases:

| Case | Assertion |
|------|-----------|
| Generator absent | no docs command invoked; no block from this capability |
| Stale check, heal disabled/exhausted | block; **neither** `createPr` nor successful push path |
| Existing-PR resume, red docs | block; no push-as-success / no advance past implement verification |
| Ordering | call log shows docs check before push/`createPr` |
| Auto-heal: generate dirties only outputs | commit proceeds; re-check green; gates re-run; then push/PR allowed |
| Auto-heal: generate no change | fail closed; no empty/fake commit |
| Auto-heal: generate fails | fail closed with generator error |
| Auto-heal: re-check still red | fail closed with stale names when parseable |
| Dirty tree before generate | no auto-commit of unrelated dirt; fail closed |
| Deliberate stale CHANGELOG / injected red check | fails before `createPr`; test fails if pre-PR path removed |
| `ci` drift-guard | structural package.json parse when generator present |
| Prompt | generator-present + docsEnabled renders regenerate+check language; absent does not require fake commands |

### D8 — Mirror packaging

**Decision:** Edit `core/` only; after prompt/engine changes run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change. Never hand-edit `plugin/`. Prompt-loader tests cover rendered core prompts; mirror check remains the packaging gate.

### D9 — Scope relative to #597 landing order

**Decision:** Requirements valid whether #597 merges first or not:

- Without generator: inert engine + conditional drift-guard.
- With generator: full enforcement + `ci` wiring.

Fixtures may simulate presence without shipping the full #597 generator into main if needed.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Local green / CI red due to CHANGELOG non-determinism | Same script locally and in CI; residual env skew → follow-up on generator determinism / fetch-depth |
| Extra generate+check on every implement | Only when generator present; one heal attempt; check is seconds |
| Heal commit invalidates review-SHA / is misclassified | Use `docs: regenerate…` subject; confirm `isPipelineInternalCommit` — do **not** silently mark as pipeline-internal unless convergence requires it; implementers check pre_merge behavior and only extend with tests if needed |
| Double-running docs:check (dedicated step + `npm run ci`) | Acceptable; second run is certification when `ci` includes the step |
| Over-broad dirty commit | Clean-tree precondition only (same as build-side-effects) |
| Treating unrelated `docs:check` as activation | Detection requires generator entry point or script value invoking it |

## Migration Plan

1. Land OpenSpec change (proposal/design/specs/tasks) with this design.
2. Implement `docs-freshness` module + wire into `resumeFromImplementing` / fix post-gate path.
3. Ensure agent-pipeline `ci` includes `docs:check` when generator is present (coordinate with or after #597).
4. Extend implementing prompt; regenerate `plugin/` via `build.mjs`.
5. `openspec validate` + `npm run ci` (and when generator present: `npm run docs:check`).
6. No rollback flag — presence-based inert when generator removed.

## Open Questions

- None blocking. Auto-heal vs fail-closed is an OR in AC; design prefers one auto-heal attempt then fail closed.
- Residual CHANGELOG non-determinism is a separate follow-up if observed after parity lands.
