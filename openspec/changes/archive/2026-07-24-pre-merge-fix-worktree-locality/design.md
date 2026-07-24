## Context

`harness-uncommitted-salvage` recovers completed-but-uncommitted harness work into a commit so
the normal verification validates it instead of the pipeline discarding it. `#547`
(`extend-fix-harness-salvage-and-discipline`) wired that fallback into the pre-merge bounded
auto-fix path, but explicitly deferred one question: does the harness's work reach the stage
worktree that salvage inspects **at all**? On lyric-utils run `648/2026-07-23` (v1.22.0,
override-resume at pre-merge) a full fix round left the stage worktree `clean … nothing to
salvage`. Salvage cannot recover work that is not in the worktree it reads, so `#547` alone
cannot close this; the locality of the work must be made an explicit, checked invariant.

## Investigation result (traced against current `main`)

- **`performPreMergeAutoFix` (`stages/pre_merge.ts`) has no cwd mismatch.** A single `wt.path`
  (from `getOnDiskForIssue`, resolved once in the `advance()` closure at `pre_merge.ts:677`) is
  used for the pre-status check, the harness cwd (`invokeFn(harness, wt.path, …)`,
  `:358`), the post-harness HEAD reads, the salvage call (`salvageFn(wt.path, …)`, `:385`), the
  rollbacks, the amend, and the push. If the harness wrote into `wt.path` without committing,
  post-#547 salvage recovers it. The `clean / nothing-to-salvage` symptom on the v1.22.0 run —
  which predates #547 — is the **fail-closed rollback** (`git reset --hard <headBefore>` +
  `git clean -fd`, `:393-398` / `:409-414`) discarding the work before any salvage existed.
- **The override-relabel full-fix surface (`stages/fix.ts`) is the real cwd risk.**
  `runOverride` relabels `needs-human → review-*` (`pipeline.ts:3766-3787`) and `runAdvance`
  routes into the fix stage. Its harness call goes through `invokeStageExecutor` (`fix.ts:572`)
  first, falling back to `invoke(harness, wt.path, …)` (`fix.ts:584`) only if no executor is
  configured. When an external executor serves the call, the harness's actual working directory
  is **not provably** the `wt.path` (`fix.ts:390`) the pipeline later inspects for salvage —
  this is the concrete checkout-mismatch seam.
- **The failure was silent.** In every discard branch the operator got `0 transitions …
  nothing to salvage` with no worktree named and no statement that completed work was lost.

## Goals / Non-Goals

**Goals**

- Make "the harness runs in the worktree the pipeline inspects" an explicit invariant covering
  both the bounded auto-fix `invoke` seam and the full-fix `invokeStageExecutor` seam, and
  drift-guard it with a deps-seam regression test.
- Turn the silent clean/no-commit discard into a **loud** escalation that names the inspected
  worktree, satisfying the user story's "or the run must fail loudly explaining where the work
  went."

**Non-Goals**

- Extending the salvage fallback's coverage (e.g. salvaging the `hasNewCommit && hasUncommitted`
  ambiguous case, or the unreadable-HEAD path) — that is `#547`'s surface and stays there.
- The foreground-test / single-turn prompt guardrail for gate commands — also `#547`.
- Any change to the fail-closed rollback mechanics or the "pipeline never merges" invariant
  (golden rules 3, 4). Salvaged pre-merge fixes remain re-reviewed, never merged.

## Decisions

### 1. Single worktree handle, asserted equal between harness cwd and salvage inspection

The invariant is stated over the deps seams so it is testable without real I/O: the cwd passed
to `invokeFn` (or the executor) SHALL equal the path passed to the salvage/status inspection.
`performPreMergeAutoFix` already satisfies this by construction (one `wt.path`); the requirement
codifies it so a future refactor that reintroduces a second checkout is caught by a biting test.
For the fix-stage executor seam, the requirement forces the executor to run in the issue
worktree (or the pipeline to inspect the executor's actual worktree) rather than silently
diverging.

**Alternative considered:** treat this as documentation-only (assert current code is correct and
close). Rejected — without a biting test the invariant can silently regress, which is exactly
how the `#547` assumption became load-bearing yet unchecked. The executor seam is a real,
present divergence path, not a hypothetical.

### 2. Disclosure augments, never replaces, the fail-closed rollback

`#547` requires the genuinely-clean case to keep its `reset --hard` + `clean -fd` + `error`
return. This change does not touch that mechanic; it only requires the clean/no-commit
escalation to carry a diagnostic naming the inspected worktree and stating no recoverable work
was found, then escalate to `needs-human`. That keeps the two changes non-conflicting: `#547`
owns *what happens to the git state*, this change owns *what the operator is told*. The
disclosure is what makes a cwd/checkout mismatch visible instead of masquerading as "the harness
chose to do nothing."

**Alternative considered:** attempt to auto-detect a cwd mismatch at runtime and re-scan sibling
checkouts for the missing work. Rejected as over-engineered and cross-host-fragile — naming the
worktree and escalating gives the operator a deterministic, debuggable signal, and the locality
invariant (Decision 1) prevents the mismatch at the source.

## Risks / Trade-offs

- **False-positive escalation** when a harness legitimately determines no change is needed: the
  disclosure will escalate a genuine no-op to `needs-human`. Accepted — a pre-merge fix harness
  invoked specifically to resolve a blocking finding that then produces nothing is itself a
  signal worth a human look, and this matches the existing fail-closed posture (which already
  returned `error` for that case; we only add disclosure).
- **Executor-locality fix scope:** if `core/scripts/executors.ts` already guarantees the issue
  worktree as cwd, task 2.2 is a test-only confirmation; if it does not, it is a small,
  surgical cwd-threading fix. Either way no salvage coverage changes.

## Test Plan

- `pre-merge-autofix.test.ts`: assert the `invokeFn` cwd equals the `salvageFn` wtPath for a
  pre-merge auto-fix run (bites if routed to a different path); assert the clean/no-commit path
  escalates with a diagnostic containing the worktree path (bites if disclosure removed);
  confirm the existing `#547` dirty-worktree salvage and rollback tests are unchanged and pass.
- Fix-stage executor-locality test (`pipeline-override.test.ts` or a fix-stage test): assert the
  executor path runs the harness in the issue worktree the salvage inspection reads.
- All tests use the `invokeFn` / executor / `SalvageDeps` seams — no real subprocess, git, or
  network.
