## Context

Issue #756 is the environmental root cause behind the #597 / PR #711 park and the partial fix in #716.

**Observed failure (Actions run on PR #711):**

1. Local agent worktree on the same head: full history + tags; `npm run ci` / `docs:check` green.
2. GitHub Actions `ci.yml` uses bare `actions/checkout@v4` (default **shallow**, limited tag set).
3. #597's generator (`scripts/generate-docs.mjs` → `listReleasesFromGit` via `git tag -l 'v*' …`) rebuilds `CHANGELOG.md` from tags.
4. Without tags, generated CHANGELOG diverges from the committed full-tag CHANGELOG → `generate-docs --check: stale generated docs: CHANGELOG.md`.
5. Pre-merge classifies the failure poorly (`classification: unknown`), exhausts recovery budget, parks the item.

**Current repo state (main / this worktree):**

- `.github/workflows/ci.yml`: `uses: actions/checkout@v4` with **no** `fetch-depth` / tag inputs.
- Release workflows already use `fetch-depth: 0` with comments about tags/annotations.
- `scripts/generate-docs.mjs` is **not** on main yet (lives on `pipeline/597-…` / PR #711) but is already specified by #597 and documented by #716.
- Root `package.json` `ci` has no docs step; CLAUDE.md / AGENTS.md / README claim conditional docs freshness when the generator is present (`test-gate-ci-parity` already requires wiring when present).
- #716 shipped pre-PR docs-freshness enforcement in the engine; it correctly blocks red docs before PR open but cannot make Actions and local see the same git tag set.

**Constraint from the issue:** pick one of (a) CI checkout fetches what generators need, or (b) generators become checkout-independent — and document why.

## Goals / Non-Goals

**Goals:**

- Make Actions PR/main CI git inputs match a normal full local clone for tag listing (and full history), so tag-sourced generator check verdicts match local on the same SHA.
- Align root `ci` with documented docs-freshness behavior using a **conditional** step (no-op without generator; real check-mode with generator) so main is coherent today and #597's merge does not reintroduce "docs in docs, not in package.json".
- Lock the checkout contract with a structural regression test (and, where cheap, a generator/tag-dependence smoke that explains why shallow fails).
- Leave a clear path to re-advance #597 after this lands.

**Non-Goals:**

- Implementing or re-landing #597's generator, README split, or CHANGELOG product design.
- Making CHANGELOG generation invent or cache release notes without git tags (would fight #597's "tags are source of truth" design).
- Changing #716's pre-PR engine path, review rigor, auto-merge policy, or pre-merge CI classification broadly beyond what is needed for this environment parity.
- Speeding CI by keeping shallow checkouts for this gate (accept longer clone as the cost of correct generator parity; this repo is small).
- Hand-editing `plugin/`.

## Decisions

### D1 — Prefer full CI checkout over checkout-independent generators

**Decision:** Fix `.github/workflows/ci.yml` to use:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
    fetch-tags: true
```

(Confirm `fetch-tags` against the pinned `actions/checkout@v4` input names — the action documents `fetch-depth` and `fetch-tags`. Do **not** invent a non-existent `tags: true` input; map the issue's "tags: true" language to the real input.)

Comment in the workflow that this exists so tag-dependent generators (CHANGELOG via `git tag -l 'v*'`) and any history-sensitive checks match local full clones and the release workflows.

**Why not make generators checkout-independent?**

| Alternative | Why rejected for this change |
|-------------|------------------------------|
| Generate CHANGELOG only from committed package version / fixed fixture | Breaks #597's product choice: historical notes from annotated tags |
| Embed release list in a committed JSON blob | New dual source of truth; out of scope; still needs a write path when tags change |
| Skip CHANGELOG check in CI | Defeats docs freshness; would reintroduce local≠CI |
| Soft-fail docs:check when no tags | Masks real staleness; still diverges from local full clone |

Full checkout is the smallest change that preserves generator semantics and matches release.yml's existing pattern.

**Alternatives considered:** `fetch-depth: 0` alone (action docs claim tags with depth 0). Prefer explicit `fetch-tags: true` as belt-and-suspenders for PR checkouts where default tag fetch has been incomplete in practice; if implement discovers `fetch-depth: 0` alone is sufficient on current checkout@v4 for `git tag -l 'v*'`, still keep an explicit comment and a regression that asserts tag availability is intended — do not drop depth 0.

### D2 — Conditional docs step always on the `ci` chain (openspec pattern)

**Decision:** Add a thin CI entry (e.g. `ci:docs` → `node scripts/ci-docs.mjs` or equivalent) that:

1. If the worktree is **not** docs-generator-present (no `scripts/generate-docs.mjs` and no generator-wired `docs:check`) → exit 0 (no-op).
2. If docs-generator-present → run check-mode only (`npm run docs:check` when that script is a real check-mode invocation, else `node scripts/generate-docs.mjs --check`).
3. Is always listed in root `package.json` `ci` so CLAUDE.md / AGENTS.md / README can truthfully say the full gate includes a conditional docs freshness step.

**Why:** On main today the generator is absent; wiring `npm run docs:check` bare would fail. The openspec step already uses this pattern. #716's living requirement says `ci` must reach docs freshness **when the generator is present**; a always-present no-op wrapper satisfies docs/package.json agreement without forcing the generator onto main.

**Why not only edit CLAUDE.md to drop the docs claim?** That would re-create the #597-class hole the moment the generator lands without a simultaneous `ci` edit. Prefer structural agreement.

Reuse detection rules already specified in `docs-freshness-gate` / #716 (`scriptIsDocsFreshnessCheck`, generator file presence) rather than inventing a third detection path. Prefer calling shared logic from `core/` only if already exported for scripts; otherwise a minimal scripts-side detection mirrored by a drift-guard test is acceptable — implement should prefer one detection definition if low-cost.

### D3 — Regression strategy

**Decision:** Prefer deterministic structural tests over live dual-checkout integration in unit CI:

1. **Workflow structural test** (scripts test or similar): parse `.github/workflows/ci.yml` and assert the `test` job's checkout step sets `fetch-depth: 0` (and `fetch-tags: true` if the design's YAML includes it). Fail if bare `actions/checkout@v4` returns.
2. **CI script graph test:** `ci` reaches the conditional docs step; when generator absent, step is no-op; when generator present (fixture), step reaches check-mode. Extend or complement existing `ciScriptReachesDocsFreshness` / #716 drift-guards.
3. **Optional / if generator is in-tree during implement:** a focused test that empty tag list vs fixture tag list changes CHANGELOG render (proves tag dependence) — already largely covered on #597's branch; do not re-implement generator here. If still on main without generator, (1)+(2) are sufficient for this change's gate.

**Issue language** "identical between shallow and full checkout": interpret the **observable goal** as local full clone and Actions CI produce the same docs-check verdict on the same SHA. After D1, Actions is no longer shallow; the regression locks the CI shape that makes that true. A test that forces shallow==full without tags would incorrectly require generator independence (rejected in D1).

### D4 — Documentation and comments

**Decision:**

- Workflow comment near checkout: full history + tags required for generator / local parity; do not reintroduce default shallow for this job.
- CLAUDE.md / AGENTS.md / README: state that `npm run ci` includes a **conditional** docs freshness step (no-op without generator; real check when present), and that CI checkout fetches full history + tags for tag-dependent generators.
- Do not claim generators are checkout-independent.

### D5 — Validation path for #597

**Decision:** After merge of this change to main, re-advance #597 / PR #711 (or merge this into that branch if sequencing requires). Success criterion: Actions no longer fails solely on empty-tag CHANGELOG staleness. Residual real failures (stale content for other reasons, unrelated CI) remain in scope for #597, not this change.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Slightly longer CI clone time | Repo is small; release already uses depth 0; acceptable for correctness |
| `fetch-tags` / depth 0 still misses annotated tag **objects** (checkout peels tags) | CHANGELOG uses `git tag -l` format fields; release.yml already documents peel issues for annotation *body* fetch — verify on implement that `%(contents:…)` works with depth 0 + fetch-tags on PR checkouts; if not, add a minimal `git fetch --tags --force` step like release.yml |
| Conditional docs script drifts from engine detection rules | Prefer shared helpers or mirrored tests; document detection contract in tasks |
| #597 still red for non-checkout reasons | Acceptance allows park for a *different, real* reason; this change only fixes environment parity |
| Double docs:check (ci:docs + test gate path) | Acceptable; same class as existing double-run notes in #716 design |

## Migration Plan

1. Land workflow checkout + conditional `ci` docs step + tests + doc sync on this branch.
2. `openspec validate` + `npm run ci` green on main-shaped tree (generator absent → docs step no-op).
3. Merge; re-run pipeline advance on #597 / PR #711 and confirm Actions checkout sees tags / CHANGELOG check matches local.
4. Rollback: revert `ci.yml` checkout and `package.json` docs step if a checkout regression breaks unrelated jobs (unlikely); keep release workflows unchanged.

## Open Questions

- None blocking design. Implement should confirm exact `actions/checkout@v4` inputs (`fetch-tags` vs any alias) against the pinned action docs at implement time (golden rule: verify external shapes).
- Whether to share docs-presence detection with `core/scripts/docs-freshness.ts` from a root `scripts/ci-docs.mjs` is an implement-time packaging choice; behavior is fixed by D2.
