## Context

`setBlocked` in `gh.ts` posts a "## Pipeline: Blocked" comment plus the `blocked` label. Its "### How to unblock" section currently hard-codes a single line:

> Run `$pipeline N --unblock "<your answer>"` to post the answer and clear the label.

`--unblock` only posts a comment and clears the label — it performs no recovery action. This is the right verb for exactly one blocker class (`needs-human`, where the block awaits a human answer). For every other class it misdirects operators.

There are ~12 structurally-distinct blocker classes spread across `planning.ts`, `fix.ts`, and `pre_merge.ts`. The call site already knows which class fired; no runtime inference is needed.

## Goals / Non-Goals

**Goals:**
- Closed enum `BlockerKind` in `types.ts` with one value per distinct blocker class.
- `setBlocked` gains an optional `kind?: BlockerKind` param (defaults to `needs-human` for any missed call site).
- The "### How to unblock" section of the blocked comment renders the kind's static recipe string.
- All existing call sites are updated to pass the correct kind.
- Snapshot tests pin each kind's recipe so stale text is caught at CI.

**Non-Goals:**
- No automated recovery actions (that is #131 / override-auto-resume territory).
- No new config keys.
- No changes to `--unblock` itself — it stays as the label-clear + comment mechanism used only by `needs-human`.

## Decisions

**Single-level enum, no hierarchy.** The ~12 blocker kinds are a flat closed set. Grouping them into families (harness-errors, git-errors, …) adds indirection without value; the recipe lookup is a simple `switch`.

**Optional `kind` parameter, not required.** Making `kind` optional with a `needs-human` default means missed call sites continue to produce a valid (if non-optimal) comment rather than a type error halting CI. This is a UX improvement rolled out incrementally; a future pass can tighten the signature once all call sites are confirmed.

**Static recipe strings, not templates.** Each kind maps to a constant string. The recipe may reference `$pipeline N` (substituted from the issue number at render time), but carries no other dynamic content. This keeps the snapshot test trivial: assert `renderedComment.includes(recipe)`.

**Enum values mirror failure-class vocabulary, not stage names.** A `test-gate-exhausted` block can occur at `implementing`, `fix-1`, or `fix-2`; naming by failure class avoids a combinatorial explosion.

**Defined kinds (closed):**

| Kind | Trigger | Recipe verb |
|---|---|---|
| `needs-human` | reviewer needs a human decision or `--override` | `--override` / fix + relabel |
| `test-gate-exhausted` | test gate failed after max fix attempts | fix failing tests, commit, re-run |
| `no-commits` | harness exited cleanly with no commits and clean worktree | re-run harness manually, commit, re-run pipeline |
| `harness-failure` | harness process crashed / timed out | investigate error above, fix root cause, re-run |
| `openspec-invalid` | `openspec validate` reported structural errors | run `openspec validate <change>`, fix errors, commit, re-run |
| `openspec-stale-delta` | pre-merge found a stale spec delta | `openspec archive <change>`, commit, re-run |
| `merge-conflict` | git push rejected (conflict / non-fast-forward) | rebase on latest target branch, resolve conflicts, push, re-run |
| `worktree-missing` | worktree path not found at dispatch time | recreate worktree or re-run pipeline from scratch |
| `worktree-creation-failed` | worktree `git worktree add` failed | check disk / git state, re-run |
| `pr-creation-failed` | `gh pr create` failed | check GitHub permissions / rate limits, re-run |
| `plan-gen-failed` | plan-generation harness returned an error | see error above, fix root cause, re-run |
| `push-failed` | git push failed for a non-conflict reason | see stderr above, fix, re-run |

## Risks / Trade-offs

**Missed call site → falls back to `needs-human` recipe** — The default preserves existing behavior; no regression possible. Risk is low. Snapshot tests will expose any newly added `setBlocked` call that omits `kind`.

**Recipe text drift** — If a verb changes (e.g., `--override` is renamed), the snapshot test catches it at CI. Recipes are plain strings, not imported from anywhere else, so there is no single source of truth beyond the snapshot itself. Acceptable for a UX hint.

**No runtime type check on kind** — Types are stripped at runtime (Node native stripping). The enum is enforced only at TypeScript-compile time (type-checked in editors/IDG, not at runtime). A runtime unit test asserting that `BLOCKER_RECIPES` has a key for every `BlockerKind` value covers this.

## Migration Plan

1. Add `BlockerKind` enum and `BLOCKER_RECIPES` map to `types.ts`.
2. Update `setBlocked` signature and comment renderer in `gh.ts`.
3. Update every call site in `planning.ts`, `fix.ts`, `pre_merge.ts`.
4. Add snapshot tests.
5. `npm run ci` from root — CI must be green before done.
