## Context

See `proposal.md` for motivation and dogfood evidence (#1010 / PR #1012).

Gate trust classification lives in `core/scripts/worktree-dirt.ts`
(`ENGINE_NON_PRODUCT_SCRATCH_GLOBS`, `classifyWorktreeDirt`, `productDirtyPaths`).
Format and test gates already hard-block only on **product** dirt and treat
engine-known scratch as clean enough for trust (#873 /
`test-gate-non-product-dirty`). The engine-known set today is only:

- `tasks/**`
- `.pipeline-prompt-*` (worktree root)

Design-gate / review challenge-response dumps land as untracked
`artifacts/challenge-response-<issue>.json` in the managed worktree (observed
sample on #1010). That path is **not** product source, but it is also **not**
in the engine set, so `productDirtyPaths` returns `artifacts/…` and the test
gate refuses the tree before (or after) a healthy run, then recovery maps the
hold toward `test-gate-exhausted`.

Related contracts that must stay intact:

- Product namespace hard boundary: `core/`, `plugin/`, `openspec/`, `hosts/`,
  `scripts/`, lockfiles, product root files (`isAlwaysProductPath`).
- Config extensions (`test_gate.non_product_dirty_globs`) are union-only and
  fail-closed against product paths — this change must not rely on per-repo
  config to fix the engine dump.
- `.agent-pipeline/**` is already covered by the engine artifact ignore
  contract (gitignored managed block). Ignored paths do not appear in default
  porcelain, so dumps that **only** live under a gitignored
  `.agent-pipeline/` tree would not trip dirty trust. Residual agent dumps at
  the untracked `artifacts/challenge-response-*.json` path still need an
  explicit classification (or cleanup) fix.

## Goals / Non-Goals

**Goals:**

- Make the observed challenge-response dump path (and any chosen relocated
  equivalent) non-product for gate trust without operator config.
- Preserve fail-closed product dirt, including anything under product
  namespaces and any broad `artifacts/**` product content that is **not** the
  challenge-response pattern.
- Keep classification pure and shared; extend existing tests rather than a
  second dirty model.
- Prefer ignore-for-trust over auto-commit or silent product commits of dumps.

**Non-Goals:**

- Waiving all of `artifacts/**` (visual-gate / HTML report trees and other
  product-adjacent content must not become blanket scratch).
- Auto-committing challenge-response JSON into the PR.
- Redesigning design-gate JSON-on-stdout contract or review severity policy.
- Changing lockfile fold or recovery recipe tables beyond correct gate outcomes.

## Decisions

### D1: Engine-known scratch glob for the observed dump path (required)

**Decision:** Add a **narrow** engine-known pattern to
`ENGINE_NON_PRODUCT_SCRATCH_GLOBS` that matches worktree-relative
`artifacts/challenge-response-*.json` (basename prefix `challenge-response-`,
`.json` suffix, under `artifacts/` only — not nested product trees).

**Rationale:** The #1010 failure is exactly that porcelain path. Classification
is the shared trust boundary already consumed by test-gate and format-gate;
extending the engine set is the minimal, config-free fix that matches #873
intent. A broad `artifacts/**` pattern is rejected: it would hide real
product-adjacent dirt and conflict with visual-gate / report publishing
surfaces.

**Alternatives considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Narrow engine glob** (chosen primary) | Fixes observed path; no config; pure tests | Agents may invent new dump names |
| Config-only `non_product_dirty_globs` | No engine code change | Does not fix dogfood by default; operators must know |
| Delete dump before test-gate | Leaves porcelain clean | Racey, stage-coupled, loses debug dump; still need classify if delete fails |
| Auto-commit dump | Clears dirt | Contaminates product history (explicit non-goal) |

### D2: Optional relocate under `.agent-pipeline/` (secondary, complementary)

**Decision:** Prefer future pipeline-owned challenge-response (and similar)
scratch under a **gitignored** `.agent-pipeline/` namespace when the engine or
prompts control the write path. Classification of the legacy
`artifacts/challenge-response-*.json` path remains required as a safety net for
harness agents that still dump there (design_response is stdout-JSON; agents
often write intermediate files anyway).

If implementation also relocates or documents a canonical path under
`.agent-pipeline/`, add that path to the engine scratch set **only if** it can
still appear in porcelain (e.g. before ignore ensure, or if gitignore is
absent). Prefer relying on the existing artifact ignore contract so porcelain
never lists those files.

**Rationale:** Issue acceptance prefers `.agent-pipeline/`; gitignore already
makes that tree invisible to default porcelain. Belt-and-suspenders
classification of the observed `artifacts/` path closes the current hole
without waiting for every harness to stop writing there.

### D3: Ignore-for-trust; do not fold dumps into product commits

**Decision:** Same as #873 D1: scratch may remain on disk; gates proceed when
product dirt is empty. Format auto-fix and test-fix salvage continue to stage
**product paths only**; challenge-response scratch must not enter those commits
(existing product-path-only salvage rules already exclude non-product
classification).

**Rationale:** Auto-committing dumps is an explicit non-goal; restore/delete is
optional and not required for trust.

### D4: Spec and test surface

**Decision:**

1. **MODIFIED** living requirement text under `test-gate-non-product-dirty` so
   the engine-known set **MUST** include the challenge-response pattern (in
   addition to `tasks/**` / `.pipeline-prompt-*`).
2. **ADDED** scenarios that pin the #1010 regression (scratch-only
   challenge-response porcelain → no hard block; mixed with product → still
   block on product).
3. **MODIFIED** `test-build-gate` “clean enough” requirement examples so
   challenge-response scratch is named alongside existing scratch examples
   (behavior already delegated to the classifier; wording must not imply any
   uncommitted path is product dirt).
4. Unit tests:
   - Pure: `classifyWorktreeDirt` /
     `productDirtyPaths(["artifacts/challenge-response-1010.json"])` → empty
     product, non-empty scratch.
   - Gate: test-gate (and format-gate pre-flight if needed) with injectable
     porcelain of only that path → no dirty hard block / no
     `test-gate-exhausted` for that dirt alone.
   - Fail-closed: `artifacts/challenge-response-1.json` + `core/scripts/foo.ts`
     still product-blocks on the core path.
   - Negative: a non-matching `artifacts/other-product-file.ts` (or similar
     non-challenge path under `artifacts/`) remains product dirt unless covered
     by another engine/config rule — proves the glob is narrow.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Agents invent new dump names (`artifacts/cr-1010.json`, etc.) | Keep glob aligned to observed naming; optional later extension; prefer `.agent-pipeline/` write path guidance |
| Over-broad `artifacts/**` waiver | Spec and implementation use only `artifacts/challenge-response-*.json` |
| Misreading “scratch” as “safe to commit” | Existing product-only salvage; non-goal bans auto-commit |
| Stale plugin mirror after `core/` edit | tasks.md requires `node scripts/build.mjs` in the same change |
| Spec drift from code comments that list only two engine globs | Update comments/schema help text that enumerate the engine set |

## Migration Plan

- No config migration. Engine set grows by default.
- Existing dirty worktrees with only challenge-response dumps become
  gate-clean on next advance without operator cleanup.
- No rollback beyond reverting the glob and tests; no durable data format change.

## Open Questions

None that block implementation. Write-path relocation under `.agent-pipeline/`
is optional complementary work; the engine glob for the observed path is
sufficient for acceptance.
