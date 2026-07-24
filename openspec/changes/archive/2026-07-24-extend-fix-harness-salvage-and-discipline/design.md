## Context

Salvage of uncommitted harness work (`salvage-harness-work.ts`, capability
`harness-uncommitted-salvage`) exists to stop the pipeline discarding a completed-but-uncommitted
diff and hard-blocking with "No commits found in the range". It is wired at the implement (success),
fix-round, test-fix, and OpenSpec-authoring call sites. Two fix-harness surfaces are *not* wired:

- **`performPreMergeAutoFix`** (`stages/pre_merge.ts`, #359) invokes the implementer with the
  surgical-fix prompt to auto-resolve a blocking pre-merge delta finding, then amends the commit to
  the canonical `PRE_MERGE_AUTOFIX_PREFIX` subject and pushes to the PR head. On `!result.success`,
  or on `hasUncommitted || !hasNewCommit`, it runs `git reset --hard <headBefore>` + `git clean -fd`
  and returns `{ status: "error" }`. The rollback is intentional fail-closed behavior — a dirty
  post-harness worktree "indicates the harness exited early or its pre-commit self-check withheld the
  commit, and we must not push a partial or self-check-rejected fix." But it also discards a *good*
  fix whose only defect was that the harness ran out of turn waiting on a background notification
  (issue #547, run 648).

- The **implement stage** (`advance` implementing path, `stages/planning.ts`) salvages *after* the
  `!result.success` early-return, so a crashed/timed-out implement harness blocks with "no commits"
  without attempting salvage. The fix stage already salvages on this exact path (`#486`,
  `stages/fix.ts` — `if (!result.success) { … trySalvageUncommittedWork … }`).

The deadlock's root cause is uniform: the embedded `claude -p` invocation is single-turn with no
notification delivery, so any prompt that lets the harness background a gate command and "wait for
the notification" ends the turn without committing. `single-turn-harness-discipline` closes this in
`implementing.md` / `fix.md` but not in the gate-fix prompts (`test_fix.md`, `eval_fix.md`,
`visual_fix.md`), which each run a repository gate command.

## Goals / Non-Goals

**Goals:**

- Preserve completed fix-harness work on every fix-harness surface — including the pre-merge
  auto-fix path and the implement crash/timeout path — by salvaging it into a commit that flows
  through the *same* downstream verification (delta re-review / test gate) as a harness-authored
  commit.
- Prevent the deadlock at its source: forbid the gate-fix prompts from ending a turn while a commit
  depends on a background task.

**Non-Goals:**

- The clean-worktree / cwd-mismatch investigation (whether the pre-merge fix harness's edits reach
  the stage worktree at all) — tracked separately as #553. If the work never reaches the worktree,
  salvage cannot recover it; this change does not attempt to.
- No auto-merge, and no bypass of any review step (golden rules 3 and 4). Salvaged pre-merge fixes
  are re-reviewed, not merged.
- No change to the salvage engine (`salvageUncommittedWork` / `trySalvageUncommittedWork`) beyond
  reusing it; its node_modules / marker exclusions and `SalvageDeps` seam are unchanged.

## Decisions

### 1. Pre-merge salvage routes through re-review, not around it

Rather than pushing a salvaged commit as an already-blessed fix, the salvaged commit is treated
exactly like a harness-authored auto-fix commit: it is amended to carry `PRE_MERGE_AUTOFIX_PREFIX`
(so the one-attempt bound still detects it), pushed to the PR head, and — because a new
developer/fix commit now sits after the last verdict — the pre-merge review-SHA gate (#16)
re-reviews it. This is what makes salvaging safe here despite the fail-closed self-check rationale:
the reviewer, not the pipeline, decides whether the recovered diff is acceptable. It also mirrors the
capability's founding principle — "the salvaged commit flows through the SAME downstream verification
as a harness-authored commit; salvage never bypasses validation."

**Alternative considered:** keep the pre-merge fail-closed rollback and rely on operators to redo the
fix manually (status quo). Rejected — it silently wastes a full fix round's tokens/wall-clock and
gives no signal that recoverable work existed.

### 2. Salvage is scoped to the "no committed fix + dirty worktree" case only

Pre-merge salvage fires when the harness produced **no new commit** (`headAfter === headBefore`,
including the crash/timeout `!result.success` case) and the worktree is dirty. When the harness *did*
produce a commit but left extra dirt (`hasNewCommit && hasUncommitted`), the existing fail-closed
rollback is retained — that ambiguous case is out of scope and folding stray dirt into a committed
fix is riskier than re-running. A genuinely clean no-commit worktree keeps today's rollback + `error`.

### 3. Reuse the shared salvage helper unchanged; wire at the call sites

Both new call sites use `trySalvageUncommittedWork` (non-throwing; a salvage failure is never worse
than today's block). No new staging scope is needed — both stage the whole worktree minus
node_modules/markers, identical to the implement/fix call sites. The implement-failure site threads
`failureReason` into its block comment (the `#521` disclosure pattern already present on the
success-path no-commit block).

### 4. Gate-fix prompts get the same discipline text, drift-guarded

`test_fix.md`, `eval_fix.md`, `visual_fix.md` each gain a single-turn paragraph matching the
committing-only variant in `implementing.md` (these stages commit but the pipeline handles pushing).
A `prompt-loader.test.ts` assertion per prompt guards against removal, consistent with how the
existing discipline is guarded for `implementing.md` / `fix.md`.

## Risks / Trade-offs

- **A salvaged pre-merge fix may be a partial / self-check-rejected diff.** → Mitigated by
  decision 1: the salvaged commit is re-reviewed by the pre-merge delta gate before any advance to
  `ready-to-deploy`; the pipeline never merges it. This is the same trust model as a
  harness-authored auto-fix commit.
- **Salvaging a crash/timeout worktree could commit genuinely half-written work.** → It flows through
  the test gate and delta re-review; a broken salvage re-blocks exactly as a broken harness commit
  would (existing capability requirement "Salvage SHALL NOT bypass the test gate").
- **Pushing the salvaged commit is an irreversible-ish surface (PR head).** → The push target and
  one-attempt bound are unchanged from the existing auto-fix path; salvage only changes *which*
  commit is pushed (a recovered one vs. none), and the bound prevents a second attempt.
- **Prompt text drift.** → Guarded by `prompt-loader.test.ts` assertions that bite on removal.

## Migration Plan

No data or config migration. Prompt and stage-logic changes take effect on the next run after the
`plugin/` mirror is regenerated. Rollback is a straight revert of the change; no persisted state
depends on it.
