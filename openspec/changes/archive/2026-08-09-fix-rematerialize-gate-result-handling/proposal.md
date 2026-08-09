## Why

Pipeline v1.30.0 can recreate a parked managed worktree successfully, then immediately treat that success as a `worktree-missing` park. Dogfood on design-gate (recovering #744 / PR #749) showed:

> design-gate: no worktree found and rematerialize failed (undefined): recreated from open PR head d3711ce

The seam returned `result: "pass"` with a usable path, but three stage consumers treated anything other than a nonexistent `"ok"` as failure. That false park blocked recoverable durable runs and burned recovery budget. The same consumer bug exists on visual-gate and eval-gate.

## What Changes

- **Align consumer result handling with the seam contract:** `EnsureManagedWorktreeResult` is `pass` | `skipped` | `fail`. Design-gate, visual-gate, and eval-gate SHALL treat only `fail` as a rematerialize failure. They SHALL continue from both success variants when a worktree path is present.
- **Keep typed failure behavior:** On `result: "fail"`, stages retain current typed `blockerKind` handling (`worktree-missing` | `worktree-creation-failed` | `worktree-capacity`) and reason text that names the rematerialize failure. Success paths SHALL never emit a reason containing `failed (undefined)`.
- **Match existing correct consumers:** Fix and pre-merge call sites already branch only on `result === "fail"`. The three gate stages adopt the same control flow.
- **Regression coverage:** Behavioral unit tests inject production-shaped `pass` and `skipped` success results (and keep existing `fail` cases) so a successful rematerialize advances without `setBlocked`.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `worktree-rematerialize`: Require every rematerialize call site — including design-gate, visual-gate, and eval-gate — to accept `pass` and `skipped` with a present worktree as success, and to park only on `fail` (or a non-usable result without a worktree path), using the seam's typed `blockerKind`.
- `design-interrogation-gate`: When design-gate rematerializes a missing managed worktree, successful rematerialize (`pass` / `skipped` with path) SHALL continue gate work from the returned path; only seam failure parks with a typed worktree kind.
- `visual-gate`: Same consumer contract when resolving the worktree for the visual command.
- `eval-gate`: Same consumer contract when resolving the worktree for the eval command.

## Impact

- **Code (implementation phase):** `core/scripts/stages/design_gate.ts`, `core/scripts/stages/visual.ts`, `core/scripts/stages/eval.ts` — rematerialize result branches only. No change to the `ensureManagedWorktree` producer contract in `worktree.ts` unless a consumer/producer mismatch is found.
- **Tests:** `core/test/design-gate-stage.test.ts`, `core/test/visual-gate.test.ts`, `core/test/eval.test.ts` — behavioral success-path coverage for `pass` and `skipped` with worktree; keep existing fail and null-worktree parks. Producer coverage in `worktree-rematerialize.test.ts` stays as-is.
- **Mirror:** After any `core/` edit, regenerate `plugin/` with `node scripts/build.mjs` in the same change.
- **Out of scope:** Expanding rematerialize to stages that do not already call the seam; changing reclaim safety (#622); durable `gate_result` schema changes; merge/auto-merge behavior.
- **Related:** #760 (rematerialize before worktree-missing park), #769 (pre-merge/fix rematerialize), #882 review recovery that partially landed the consumer fix on main — this change closes #874 with explicit requirements and full success-variant coverage.

## Acceptance criteria

Observable, falsifiable outcomes that make #874 done:

- [ ] Design-gate continues from a successfully rematerialized worktree (`result: "pass"` with path) without `setBlocked` solely for rematerialize success.
- [ ] Visual-gate continues from a successfully rematerialized worktree and runs its command (or subsequent gate logic) against the returned path.
- [ ] Eval-gate continues from a successfully rematerialized worktree and runs its command against the returned path.
- [ ] Each of the three stages also continues when rematerialize returns `result: "skipped"` with a non-null worktree path.
- [ ] Each of the three stages still parks on `result: "fail"` with the seam's typed `blockerKind` (`worktree-missing` | `worktree-creation-failed` | `worktree-capacity`) and a reason that names the rematerialize failure.
- [ ] A successful rematerialization never emits a blocking reason containing `failed (undefined)`.
- [ ] Unit tests prove the success variants with injected production-shaped results (no source-text-only assertions); existing fail cases remain green.
- [ ] After `core/` changes, `plugin/` is regenerated (`node scripts/build.mjs`) and `npm run ci` passes.
