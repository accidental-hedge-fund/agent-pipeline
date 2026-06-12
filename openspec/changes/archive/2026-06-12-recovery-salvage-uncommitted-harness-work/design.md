## Context

When an implementer/fix harness exits with code 0 but without committing, two separate block sites fire:

1. `fix.ts:126-133` — direct `headBefore === headAfter` guard → `setBlocked("no new commits")`
2. `planning.ts:243-252` — `verifyHarnessCommits` returns `"No commits found in the range…"` → `setBlocked`

Neither site checks whether the worktree is dirty before blocking. The `auto_recover.ts` stage fires only for `implementing` + `blocked` with zero commits ahead of base; its `hasCommitsAhead` guard causes it to no-op when a planning commit is already present, so the "did work, didn't commit" case falls through to a permanent block. Even when auto-recover does fire (truly empty worktree), it deletes and retries from scratch — it never salvages.

`hasDirtyWorkdir` (worktree.ts:275) already detects uncommitted changes via `git status --porcelain`. The `parseDirtyFiles` helper (verify-harness-commits.ts:83) extracts the file list from that output.

## Goals / Non-Goals

**Goals:**
- Before any "no new commits" block, check whether the worktree has uncommitted changes.
- If dirty: stage all changes (`git add -A`) and commit with a salvage message carrying `Issue:` and `Pipeline-Run:` trailers, then proceed as if the harness had committed.
- If clean: fall through to the existing block/auto-recover path — no behavior change.
- Salvaged commits pass through the existing test gate, so a partial/broken salvage still blocks normally.

**Non-Goals:**
- No change to `auto_recover.ts` (its delete-and-retry for truly empty worktrees stays).
- No new config key (salvage is always-on; discarding verified harness work is strictly worse).
- No change to the test gate, review, SHA-gate, or pre-merge contracts.
- No salvage of harness work in the planning-commit range (OpenSpec scaffolding commits are pipeline-owned, not harness-owned; that path already blocks on `verifyHarnessCommits` with its own error message).

## Decisions

**Decision: salvage lives in a new `salvage-harness-work.ts` module, not inside `verifyHarnessCommits`.**
`verifyHarnessCommits` is a verification function — injecting a side-effecting commit into it violates single-responsibility and makes the deps interface confusing (it would need a git-commit injectable). The salvage pre-pass belongs at the call sites (`planning.ts`, `fix.ts`) that already control the `headBefore`/`headAfter` comparison and own the `setBlocked` call. Each call site: (1) check dirty, (2) if dirty → salvage → re-read `headAfter` → proceed to verify, (3) if clean → existing block path.

**Decision: salvage commit message format is `salvage: stage harness work (#<N>)\n\n<body>\n\nIssue: #<N>\nPipeline-Run: <id>`, with the stage's prescribed commit subject embedded in the body.**
The subject prefix `salvage:` is distinct from `feat:`/`fix:`/`chore:` so it is grep-visible and clearly pipeline-owned. The body names the harness stage (implement/fix-N/test-fix) for forensic traceability. `Issue:` and `Pipeline-Run:` trailers satisfy the existing `commit-traceability-trailers` spec. For stages whose downstream gate prescribes a message format (fix rounds: `fix: address review N findings (#N)`; test-fix: `fix: resolve test/build failures (#N)`), the stage label includes that prescribed subject (`fixSalvageStageLabel` / `testFixSalvageStageLabel`), and because the format gates match against the full message (subject + body), the salvaged commit satisfies the gate and the run proceeds to the test gate. *Resolution note:* an earlier draft of this design had the salvage message deliberately not match the fix-round pattern, accepting a downstream format block — that contradicted the proposal ("the appropriate commit-message format for that stage"), tasks 4.2/4.4 (salvage continues to the test gate), and the salvage spec scenarios (fix-round salvage proceeds; test-fix salvage re-runs the test command). The embedded-prescribed-subject approach satisfies all of those without changing any verification gate: the gates' code and patterns are untouched, and the body line truthfully declares which prescribed commit the salvage stands in for. Contract tests pin the labels against the real gate patterns so drift between them fails the build.

**Decision: injectable deps seam on `salvageUncommittedWork` via a `SalvageDeps` parameter.**
Consistent with the `AdvanceReviewDeps` / `ShaGateDeps` / `VerifyDeps` pattern already in use. Unit tests supply fake `gitAddAll`, `gitCommit`, and `hasDirty` functions; no real subprocess calls in tests.

**Decision: salvage applies only in the "no commit but dirty" case — NOT as a catch-all commit after every harness run.**
A harness that did commit normally must not have those commits silently overwritten or re-added. The salvage gate is specifically: `headBefore === headAfter && hasDirtyWorkdir`.

## Risks / Trade-offs

- *Salvage commit fails the format/trailer verify checks downstream* → The salvage message carries the real trailers and embeds the stage's prescribed commit subject, so both checks pass on a well-formed salvage; any other prescribed invariant (e.g. the OpenSpec-authoring `openspec/`-only path constraint) still verifies the salvaged commit and blocks on violation — salvage gets no bypass.
- *Harness produces a partial/broken change* → The test gate runs after salvage and will catch it; no integrity loss.
- *Salvage on a very large dirty change* → `git add -A` in the worktree is bounded to the issue's worktree; no cross-issue risk.
- *`fix.ts` headBefore===headAfter guard vs. verifyHarnessCommits* → fix.ts has an explicit equality guard (line 126) before calling `verifyHarnessCommits`; salvage must be wired at that guard, not only inside `verifyHarnessCommits`, or fix.ts would still block before reaching it.
