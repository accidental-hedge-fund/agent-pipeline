## Context

Issue #716 is a factory-reliability follow-up to the #597 / PR #711 failure class:

1. Implement + test-gate advertised success and opened a PR.
2. Core unit tests were green (~5635 pass).
3. GitHub Actions `npm run ci` failed only on `generate-docs --check: stale generated docs: CHANGELOG.md`.
4. Pre-merge blocked with `ci-exhausted` / human intervention.

On this repo, `test_gate.command` is already `"npm run ci"` (`test-gate-ci-parity`). The #597 branch wires:

- `docs:generate` → `node scripts/generate-docs.mjs`
- `docs:check` → `node scripts/generate-docs.mjs --check`
- `ci` chain includes `npm run docs:check` after the plugin mirror check

So **CI parity via the full `ci` script is the right spine** — but it is not sufficient by itself if:

- the generator is introduced or edited without regenerating outputs before push,
- the fix harness "fixes" test failures without refreshing generator outputs,
- operators (or future repos) drop `docs:check` from `ci` while leaving the generator,
- or a dedicated auto-heal path never commits regenerated files (dirty tree after generate would also fail the test-gate clean-tree invariant, but only after a confusing failure).

This change hardens the **pre-PR** path so stale generated docs cannot reach pre-merge as the first discovery site.

## Goals / Non-Goals

**Goals:**

- When a docs generator / `docs:check` surface is present in the worktree, implement verification and the local test-gate enforce the **same** freshness check CI will run, **before** push/PR create or update.
- Prefer deterministic **auto-heal** (regenerate → commit outputs → re-check) over relying solely on the LLM fix harness to invent the right commands.
- Fail closed with stale file names if heal is exhausted or impossible.
- Drift-guard the `ci` script wiring when the generator is present.
- Strengthen implement prompt language for generator-touching / docs-primary work.
- Prove with a unit/fixture regression that PR creation does not run when docs check is red.

**Non-Goals:**

- Hand-fixing #597 / PR #711.
- Making CHANGELOG generation fully environment-invariant (shallow-clone / tag-body edge cases) beyond what #597 already specifies — track residual non-determinism only if gate parity still cannot pass in CI after local green with identical tree.
- Replacing human CI for non-docs failures.
- Loop resume stranding (#712) or OpenSpec archive skip-then-block (#714).
- New config knobs for consumer repos that do not ship a docs generator (behavior MUST be inert when the generator is absent).
- Auto-merge or weakening review rigor.

## Decisions

### D1 — Activation is presence-based, not a new pipeline.yml flag

**Decision:** Activate docs-freshness behavior when the worktree has the docs generator entry point (`scripts/generate-docs.mjs` and/or a `package.json` script `docs:check` that invokes it). When absent, all new paths are no-ops.

**Why:** Matches how OpenSpec CI validation is conditional on `openspec/` presence. Avoids forcing every consumer repo to configure a docs gate. On agent-pipeline itself, once #597 (or equivalent) lands the generator, activation is automatic.

**Alternatives considered:**

- Always-on new `docs_gate` config key — more operator surface for a problem specific to repos that generate docs.
- Hard-code agent-pipeline-only paths in the engine — breaks the "pipeline develops itself with general mechanisms" rule.

### D2 — Prefer full-CI inclusion + deterministic regenerate-and-fold over a parallel always-on gate

**Decision:**

1. **CI spine (modified `test-gate-ci-parity`):** When the generator is present, `package.json` `ci` MUST include the docs-freshness step (`npm run docs:check` or `node scripts/generate-docs.mjs --check`). A drift-guard test fails if the step is dropped while the generator remains. `test_gate.command` remains `"npm run ci"`.

2. **Pre-PR regenerate-and-fold (new `docs-freshness-gate`):** On the implement post-harness path (and the same place fix/auto-fix rounds fold build artifacts — after commits, before or as part of format/test convergence), when the generator is present:
   - Run generate (write mode).
   - If the worktree becomes dirty, stage and commit regenerated outputs with a conventional message (e.g. `docs: regenerate generated docs (#N)`), preserving trailer discipline where the round already requires trailers.
   - Re-run `--check`. If still red, block with the check output (stale file names) and **do not** call `createPr` / treat implement as successful.
   - If generate fails hard (exit non-zero for reasons other than staleness), block with the generator error.

**Why:** Mirrors `build-side-effects` / plugin-mirror hygiene: deterministic machinery folds generated artifacts; the test-gate then certifies the committed tree. Relying only on the LLM fix loop to run `docs:generate` is how #597-class failures slip through when unit tests are green.

**Alternatives considered:**

- Only extend `npm run ci` and trust the fix harness — insufficient for the observed failure class (tests green, docs red).
- Only prompt the implementer — prompts are necessary but not sufficient (rigor over hope).
- Separate long-running docs-only stage label — overkill for a generate+check that should be seconds.

### D3 — Fail closed before PR create/update, not only on "new PR"

**Decision:** The block must sit on the shared post-implementation path used by both first open and resume (`resumeFromImplementing` / format+test gates → push → create-or-find PR). A resume that would only push/update an existing PR also MUST NOT advance past a red docs check.

**Why:** AC says never open **or update** a PR with a failing docs check. The #711 path is "open," but resume after a partial fix is the same risk.

### D4 — Prompt contract is additive to `steps.docs`, not a second stage

**Decision:** Extend the implementing docs instruction (and/or a generator-aware appendix when the generator is present in the repo conventions excerpt) so that when the change touches the docs generator, its templates, or its outputs, the implementer MUST regenerate and commit **all** generator outputs in the same change. Docs-primary issues (like #597) are called out explicitly in the verification contract language.

**Why:** AC4. Keeps a single implement turn; no new stage label.

### D5 — Tests use injectable seams; prove bite

**Decision:**

- Unit tests inject fakes for generate/check, git dirtiness, commit, and `createPr` — no real network/git/subprocess in unit tests.
- One regression asserts: deliberate stale docs → gate/block path → `createPr` not called.
- One drift-guard asserts: if `scripts/generate-docs.mjs` exists (or is stubbed as present in the fixture), `package.json` `ci` includes `docs:check` (or the equivalent check invocation). When the generator is absent on main during early implementation, the drift-guard may be written as a conditional or land with the generator; implementers MUST NOT weaken the "when present" requirement.
- Prove the test bites by construction (would fail if pre-PR check/block is removed).

### D6 — Scope relative to #597 landing order

**Decision:** This change's requirements are valid whether #597 merges first or not:

- Without the generator: inert.
- With the generator: full enforcement.

If implement of #716 lands before #597, only prompts/drift-guard scaffolding and inert paths ship; full behavioral tests that need a real generator may use fixtures under `core/test/` that simulate presence without shipping the full #597 generator into main.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Local green / CI red due to CHANGELOG non-determinism (git tags, shallow clones) | Gate parity still runs the same script; if residual env skew remains, file a follow-up on generator determinism / CI fetch-depth — out of scope unless it blocks AC |
| Extra generate+commit on every implement slows the path | Only when generator present; generate should be seconds; commit only if dirty |
| Auto-heal commit confuses review-SHA / internal-commit classification | Use a conventional `docs:` subject so pipeline-internal commit classifiers can treat it like other docs/chore internal commits if needed; design implementers must check `isPipelineInternalCommit` behavior and extend only if required for convergence |
| Double-running docs:check (fold + `npm run ci`) | Acceptable cost; second run is the certification step |
| Over-broad dirty commit stages unrelated files | Fold only after a clean tree precondition (same as build-side-effects), so dirt is attributable to generate |

## Migration Plan

1. Land OpenSpec change (this proposal/design/specs/tasks).
2. Implement presence-based fold + fail-closed pre-PR; wire tests.
3. Ensure `ci` includes `docs:check` when generator is present (coordinate with or after #597).
4. Validate with `openspec validate` + `npm run ci`.
5. No rollback flag needed — presence-based inert when generator removed.

## Open Questions

- None blocking the spec: auto-heal vs fail-closed is an OR in AC2; design prefers auto-heal first, then fail-closed.
- Residual CHANGELOG non-determinism is a separate follow-up if observed after parity lands.
