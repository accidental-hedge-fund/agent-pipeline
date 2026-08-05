## Context

The test/build gate (`core/scripts/testgate.ts`) requires a clean worktree before
the first trusted command run and again after a pass, so results certify committed
state. Cleanliness is currently a boolean: any non-empty `git status --porcelain`
(via `defaultGitDirty`) hard-blocks with `dirtyWorktree: true`.

The format gate’s pre-flight dirty check uses the same absolute model. On the
implement path, `runFormatAndTestGates` runs after implement (and after lockfile
fold #722). Agent scratch left dirty after a real product commit — especially
`tasks/todo.md` (planning notes; authoring salvage already leaves it dirty under
scoped salvage / `allowDirtyPattern: /^tasks\//`) and ephemeral
`.pipeline-prompt-*` files — therefore blocks certification even when product HEAD
is correct.

Observed failure mode (#762): product commits present; sole dirt `M tasks/todo.md`;
block classified as test-gate / implementation-ci; durable recovery tried
`verify_head_goal` / `rerun_ci` and exhausted. Related closed work:

| Issue | Scope | Gap |
|-------|--------|-----|
| #722 | Fold lockfiles before implement gates | Locks only |
| #358 | Fix-path lockfile fold | Fix only |
| #321 | Planning salvage leaves `tasks/todo.md` dirty intentionally | Does not stop implement gate from treating that dirt as product |

## Goals / Non-Goals

**Goals:**

- Treat engine-known non-product scratch as non-blocking for gate **trust**
  decisions on the implement certification path (format + test pre-dirty, and
  post-pass dirty when only scratch remains).
- Keep product dirt fail-closed with path disclosure.
- Preserve lockfile fold semantics (fold, not ignore).
- Make operator/recovery-facing copy honest: scratch-only must not look like a
  failed test command or fix exhaustion.
- Bite with injectable unit tests (no real git/network/subprocess).

**Non-Goals:**

- Allowing uncommitted product source / specs / plugin mirror through the gate.
- Changing human-input / design-gate classification (#872).
- Expanding salvage to auto-commit `tasks/todo.md` into product history.
- Cross-host concurrency changes.
- Auto-merge or recovery-recipe rewrite beyond what correct gate outcomes already
  fix (recovery should simply not see this as `test-gate-exhausted`).

## Decisions

### D1: Ignore for trust (not fold; discard optional)

**Decision:** Classify porcelain paths into **product dirt** vs **non-product
scratch**. If product dirt is empty, the gate treats the worktree as clean enough
and proceeds. Scratch may remain on disk; it does not need to be staged.

**Alternatives considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Ignore for trust** (chosen) | Matches #321 leave-todo-dirty intent; no product commit pollution; reversible | Worktree remains “dirty” for operators inspecting raw git status |
| Auto-restore / discard scratch | Leaves tree porcelain-clean | Destroys agent notes; surprising if `tasks/todo.md` had intentional local edits |
| Fold / commit scratch | Clears dirt | Contaminates PR history with non-product noise; conflicts with authoring path constraints |

**Optional restore:** Implementation MAY restore/discard scratch paths *after*
successful gate classification or as a separate opt-in, but the **required**
behavior is ignore-for-trust. Prefer not discarding `tasks/todo.md` by default.

### D2: Engine-known path set first; optional config extension

**Decision:** Ship a fixed engine-known matcher used by default, covering at least:

- `tasks/todo.md` (and preferably `tasks/**` planning scratch, aligned with
  authoring `allowDirtyPattern: /^tasks\//`)
- `.pipeline-prompt-*` (and similar engine prompt drop files at worktree root)

Operators MAY extend via an optional config list (e.g.
`test_gate.non_product_dirty_globs` or a shared gate-trust ignore list) that is
**unioned** with the engine set — never used to replace product fail-closed
defaults. Config cannot mark `core/`, `plugin/`, or arbitrary product roots as
scratch via a “replace engine set” mode in this change.

**Rationale:** Dogfood failures are engine-generated paths; a fixed set unblocks
immediately without requiring every consumer repo to configure. Extension covers
repo-specific agent notes without reopening the trust model.

### D3: Shared pure classifier; both format and test gates use it

**Decision:** Extract a pure helper (e.g. `classifyWorktreeDirt(porcelainPaths)`
or `productDirtyPaths(...)`) used by:

1. Test gate pre-run and post-run dirty checks (`testgate.ts`)
2. Format gate pre-existing dirty check when that check would otherwise refuse to
   run (`format-gate.ts`), so implement-path order cannot still hard-stop on
   scratch before the test gate.

**Rationale:** #762-class failures hit whichever gate runs first. Fixing only
`testgate.ts` leaves format-gate pre-flight as a second hard block with the same
root cause.

**Out of scope for the pure helper:** lockfile recognition (locks continue to be
folded by `includeLockfileSideEffects` before gates; they are not scratch).

### D4: Path matching semantics

**Decision:** Match against porcelain **paths only** (status columns stripped),
repo-relative, using the same path list the gate already surfaces. Matching is
path-prefix / glob style consistent with existing engine patterns (e.g. `tasks/`
prefix and basename/prefix patterns for `.pipeline-prompt-*`). Untracked and
modified statuses are treated the same for classification.

**Product dirt** = any porcelain path that does **not** match the non-product set
(after optional config extension). Empty product dirt ⇒ clean enough.

### D5: Messaging and recovery classification

**Decision:**

- When the gate **proceeds** despite residual scratch, no dirty block is emitted;
  optional log line may note ignored scratch paths (non-blocking).
- When the gate **blocks** on product dirt, `blockReason` continues to name
  **product** uncommitted paths. Implementation SHOULD omit pure-scratch paths
  from the blocking disclosure (or label them separately as non-blocking) so
  recovery does not treat scratch as the actionable failure.
- Existing dirty-vs-exhaustion wording (#722) remains: product dirty blocks are
  still not worded as “failed after N fix attempt(s).”
- Scratch-only must never set a blocker kind that durable recovery maps to
  “re-run CI / fix tests” as the primary recipe.

### D6: Relationship to lockfile fold and salvage

**Order on implement path (unchanged except for classification):**

1. Implement / salvage / HEAD advance as today  
2. Lockfile fold (#722) if recognized locks dirty  
3. Format + test gates with **product-dirt** trust check  

Salvage and authoring `allowDirtyPattern` stay as-is; this change does not
re-stage `tasks/todo.md` into salvage commits.

### D7: Tests

- Injectable porcelain / dirty seams only.
- **Bite test:** scratch-only porcelain → gate would have blocked without
  classification; with it, proceeds (or restore-then-proceed).
- **Fail-closed test:** mixed scratch + product path → still blocks; product path
  in reason.
- Lockfile fold regression remains green (no reclassification of locks as ignore).

## Risks / Trade-offs

- **[Risk] Over-broad `tasks/**` ignore hides product files under `tasks/`.**  
  → Mitigation: default to `tasks/` only if this repo treats that tree as
  agent scratch (current authoring pattern); if a consumer stores product under
  `tasks/`, they must not rely on the default — document the engine set; keep
  globs narrow where possible (`tasks/todo.md` minimum, extend carefully).

- **[Risk] Tests run against a worktree that still has scratch files on disk,
  and some test suite is sensitive to those files.**  
  → Mitigation: engine scratch paths are outside product trees; if a suite fails
  because of them, that is a product concern. Optional restore can be a follow-up.

- **[Risk] Operators misconfigure extension globs to ignore product paths.**  
  → Mitigation: document that config **extends** the engine set for known scratch
  only; do not add a “replace” mode; review still fails closed on real product
  dirt in normal use.

- **[Risk] Format and test gates drift if only one is updated.**  
  → Mitigation: shared helper + tests that cover both call sites (or
  `runFormatAndTestGates` integration-shaped unit tests with fakes).

## Migration Plan

1. Land pure classifier + wire testgate and format-gate dirty checks.  
2. Add unit/regression tests; regenerate `plugin/` if `core/` changes.  
3. No config migration required for the engine default set.  
4. Rollback: revert the change; behavior returns to any-dirt hard block.

## Open Questions

- Exact default globs beyond `tasks/todo.md` and `.pipeline-prompt-*` (e.g. full
  `tasks/` prefix vs only `todo.md`) — implementer SHOULD align with authoring
  `allowDirtyPattern` (`/^tasks\//`) unless a narrower set is required for safety.
- Whether optional post-success restore of scratch is in v1 or a follow-up; v1
  required behavior is ignore-for-trust only.
