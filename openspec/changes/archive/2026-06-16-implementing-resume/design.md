## Context

`implementing` is currently a terminal dispatch case that returns `{ advanced: false, status: "waiting" }` unconditionally (pipeline.ts:1067–1072). This is correct for the in-flight case — the planning handler sets the label mid-run and the loop continues — but it is wrong for re-entry: a re-run that starts with `stage=implementing` cannot advance regardless of what exists in the worktree.

Two distinct failure modes both land an issue at `implementing + blocked`:

| Scenario | Worktree | Commits ahead | Auto-recover handles? |
|---|---|---|---|
| Implementer produced no output | exists or missing | 0 | ✅ yes — resets to `ready` |
| Gate/push/PR failed after implementation | exists | ≥1 | ❌ no — returns `no-op` |

The second scenario is the gap. After `--unblock` removes the `blocked` label, the dispatch case returns "waiting" instead of proceeding to the post-implementation steps.

## Goals / Non-Goals

**Goals:**
- Re-entry at `implementing` with commits in the worktree (unblocked or never-blocked) resumes at gate → push → PR → review-1.
- The "nothing to do" response is preserved as the fallback when no worktree+commits exist.
- No re-planning or re-implementing on resume — the existing implementation is used as-is.
- If a PR was already opened by a prior partial run, it is reused (no duplicate PR).

**Non-Goals:**
- Resuming a partially-committed implementation (git history with only some of the expected commits) — that case stays manual.
- Changing `auto_recover.ts` — the no-commits reset path is separate and correct.
- Adding a new pipeline label for the resumed state — `implementing` already conveys "work is in progress toward a PR."

## Decisions

**Decision: extract `resumeFromImplementing()` rather than duplicating steps.**
The gate+push+PR block already exists in two places (`advance()` for the standard flow, `advanceOpenspec()` for the OpenSpec flow). Rather than adding a third copy in the dispatch path, extract a shared helper. Both existing flows call it at their end; the dispatch resume path calls it as its sole body. This is the only clean way to handle the distinct PR body difference (standard vs. OpenSpec flows have different bodies) without a new parameter explosion — accept the PR body as a parameter.

**Decision: check `hasCommitsAhead` to gate the resume path.**
`getForIssue()` returning a worktree is necessary but not sufficient — the worktree could exist with no commits (auto-recover's domain). `hasCommitsAhead(wt.path, cfg.base_branch)` already exists and is the correct discriminator.

**Decision: check `getPrForIssue()` to detect an existing PR before creating one.**
The standard flow already does this defensively inside the `createPr()` catch block. On the resume path, it should be checked proactively (before the `createPr()` call) since the PR may have been opened by the original partial run that then failed at the transition step.

**Decision: the dispatch `implementing` case calls a new `planning.dispatchResume()` function, not `planning.advance()`.**
`planning.advance()` starts from `ready` and runs planning through implementation. The resume path needs only the tail: gate + push + PR + transition. A dedicated export makes the boundary explicit and avoids threading a "resume mode" flag through `advance()`.

## Risks / Trade-offs

- **Worktree branch/slug recovery**: `dispatchResume()` must reconstruct the branch name and PR body without access to the in-memory plan/proposal text from the original run. The PR body can be minimal ("resuming implementation for #N") or can inspect the existing commit log. Keep it minimal: the original PR body is already posted if the PR exists, and the transition comment carries the PR number.
- **OpenSpec vs. standard flow detection**: The resume path needs to know which flow was used to reconstruct the correct PR body. Check `openspec.shouldPlanWithOpenspec(cfg, cfg.repo_dir)` — the same flag used in `advance()`.
