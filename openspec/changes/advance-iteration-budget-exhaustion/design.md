## Context

See `proposal.md` for why. Current law and code:

- Living `pipeline-state-machine` "Bounded advance loop" caps a single `runAdvance` at `MAX_ITERATIONS` (= 12). Each iteration dispatches one stage and either advances or `break`s on a non-advancing outcome. When the `for` condition fails, the run prints `done — <start> → <stage> (N transitions, …)` and returns without setting `process.exitCode`.
- `#773` (`shouldRunDeferredTerminalFinalize`) already runs `deploy_ready.finalize` after the loop when `finalStage === "ready-to-deploy"` so PR tagging never depends on a spare iteration. There is no post-loop handler for any other final stage.
- `autoLoopExhaustedBlockedOutcome(out, stage)` already maps a budget-exhausted wait at `pre-merge` to blocker kind `ci-exhausted` (diagnostic `implementation-ci`, offramp `ci-failed`) and every other stage's wait to `needs-human` (workflow-state, not human-authority). That helper's reason string currently prefixes `auto-loop budget exhausted at <stage>`.
- Durable park-release (`maybeReleaseWorktreeOnPark`) already runs on in-loop blocked / needs-human stops. The #1243 fall-out never reached that path, so the worktree stayed counted against capacity.
- `finalizeRun` always appends `run_complete` with `{ final_state, elapsed_ms }`. `pipeline logs --events --follow` ends on that event.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is #1243 / PR #1244 dying at `pre-merge` after 12 transitions. The class is: `MAX_ITERATIONS` fall-out at a non-terminal stage is an incomplete invocation, not success. A pre-merge-only `console.error` that still exits 0 at `review-1` is a mole.
2. **Shared surfaces.** Detection and operator/machine signaling live in the `runAdvance` post-loop (same place as #773). Pre-merge park reuses the existing `ci-exhausted` kind mapping and `maybeReleaseWorktreeOnPark`. No new `BlockerKind`, no second recoverer, no merge inside advance/loop.
3. **Next identical fault.** The next issue that burns the cap at `review-1`, `fix-2`, `eval-gate`, or `pre-merge` hits the same post-loop predicate. Tests fail if that path prints `done —` and exits 0.

## Goals / Non-Goals

**Goals:**

- Distinguish loop-exhausted from loop-broke in one shared predicate, exported for unit tests (same shape as `shouldRunDeferredTerminalFinalize`).
- Make non-terminal exhaustion operator-visible (distinct line, no `done —`) and machine-visible (non-zero exit, typed `run_complete.stop_reason`).
- At `pre-merge`, park with the existing `ci-exhausted` mechanical shape and attempt park-release.
- Keep #773 deferred finalize as the only post-loop success path.

**Non-Goals:**

- Raising, lowering, or configuring `MAX_ITERATIONS`.
- Continuing remaining stages in the same invocation (option (a) in the issue user story). Re-run is the continue mechanism.
- Changing `auto_loop` eligibility, continuation, or auto-loop exhaustion comments.
- Parking every non-terminal stage with `ci-exhausted` or `needs-human`. Only `pre-merge` parks.
- Fixing pre-merge-park re-entry `worktree_unavailable` (#1243).
- Dropping `run_complete` (that would hang logs-follow).
- Merging inside advance/loop; `auto_merge`; a merge stage.

## Decisions

### 1. Post-loop class handler, not a stage-local mole (primary)

**Choice:** After the `MAX_ITERATIONS` loop, if the loop completed without `break` (iteration budget exhausted) and `finalStage` is not `ready-to-deploy` and not `needs-human`, run a shared incomplete-invocation handler. `#773` stays first: if `shouldRunDeferredTerminalFinalize` is true, finalize and skip the incomplete handler.

**Why:** The fall-out is in `runAdvance`, not in `pre-merge.ts`. A pre-merge-only check would miss `review-1` / `eval-gate` budget death. Composing with #773 keeps one post-loop switch: R2D → deferred finalize; other non-terminal → incomplete.

**Alternatives considered:**

- Deferred-continue remaining stages in the same process (user-story option (a)) → rejected. Out of scope; would re-enter pre-merge gates without a new iteration budget and blur the cap.
- Only print a warning and still exit 0 → rejected. Supervisors treat exit 0 plus `done —` as success.
- Park every non-terminal stage with `needs-human` → rejected. A `review-1` re-run should continue from the same label without a human-authority hold. AC requires park only at `pre-merge`.

### 2. Exhaustion means the for-loop completed; a break is not exhaustion

**Choice:** Track `iterationBudgetExhausted = true` only when the `for` loop ends because `i === MAX_ITERATIONS`, not when it `break`s. Export a pure helper `shouldHandleNonterminalIterationExhaustion({ dryRun, iterationBudgetExhausted, finalStage })` analogous to `shouldRunDeferredTerminalFinalize`.

**Why:** An in-loop `waiting` at pre-merge (CI still running) is a legitimate stop and already specified to end without error. Treating that as budget death would block issues that are actually waiting on CI. The #1243 bug is specifically "no break, cap hit, remaining gates unrun."

**Alternatives considered:**

- Treat `transitions === MAX_ITERATIONS` as exhaustion even after a waiting break on the last iteration → over-closed; that last iteration did run the stage.
- Count only advancing iterations → the cap is dispatches, not advances; keep matching the loop bound.

### 3. Reuse the ci-exhausted kind mapping; do not reuse the auto-loop reason prefix

**Choice:** At `pre-merge`, materialize a blocked outcome with kind `ci-exhausted`, diagnostic `implementation-ci`, and offramp `ci-failed` by calling the existing mapping in `autoLoopExhaustedBlockedOutcome` (or a thin shared extractor of that mapping). Then set the reason text to name **iteration-budget** exhaustion (issue number and stage). Call `setBlocked` and `maybeReleaseWorktreeOnPark` with that outcome, mirroring the auto-loop exhausted path's park-release. Do not add a `BlockerKind`.

**Why:** AC requires the existing `ci-exhausted` / `implementation-ci` shape so durable recovery treats it as mechanical CI-class work, not a janitor hold. The current helper reason `auto-loop budget exhausted at pre-merge: …` is false when `auto_loop` is off (the observed run). Operators and recipes key on kind; the reason still must tell the truth about which budget died.

**Alternatives considered:**

- Call `autoLoopExhaustedBlockedOutcome` unchanged → rejected. Reason lies about auto-loop.
- New `BlockerKind` `iteration-budget-exhausted` → rejected by AC (reuse existing shape) and by closed-enum snapshot cost.
- Leave the issue unblocked at `pre-merge` so a second `/pipeline N` continues immediately → rejected by AC item 3 (park + release). Durable `implementation-ci` recovery is the re-entry for loop/train; a single advance will surface the blocked recipe.

### 4. Additive stop_reason on run_complete; still write the event

**Choice:** Keep writing `run_complete` from `finalizeRun` so logs-follow ends. Add optional `stop_reason?: "iteration-budget-exhausted"` (additive; `schema_version` stays `1`). Set it only on the non-terminal exhaustion path. Do not set it on deferred R2D finalize or in-loop waiting/blocked stops.

**Why:** AC forbids a terminal-success `run_complete` shape. Omitting the event would hang `pipeline logs --events --follow`. Unknown fields are already preserved by the events reader. A typed field is the class signal for any consumer that ignores exit codes.

**Alternatives considered:**

- Omit `run_complete` → breaks logs-follow until-terminal.
- Encode incompleteness only in `final_state` (e.g. `iteration-budget-exhausted`) → breaks evidence `finalState` as a stage name.
- Console marker only, keep exit 0 → AC allows "or a typed console marker" as a weaker option; we take both non-zero exit and the event field so supervisors cannot miss it.

### 5. Tests inject the exhausted loop; prove they bite

**Choice:** Add unit tests that drive `runAdvance` with injected `getIssueDetail` / stage deps so the loop advances until the cap at `pre-merge` and at `review-1` with `auto_loop` disabled. Assert: no `done —` line, exhausted line present, `process.exitCode !== 0`, `run_complete.stop_reason === "iteration-budget-exhausted"`. Second test: pre-merge path calls `setBlocked` with `ci-exhausted` and `releaseParkedWorktree` (or `maybeReleaseWorktreeOnPark` seam). Keep existing `deferred-terminal-finalize.test.ts` assertions. No live network, git, or subprocess.

**Why:** The #1243 log is exactly "12 transitions, done, exit 0, no blocker." A pure helper test is necessary but not sufficient; the wiring in `runAdvance` is the hole.

## Risks / Trade-offs

- **[Risk] Parking `pre-merge` with `ci-exhausted` makes a naive second `/pipeline N` hit already-blocked instead of continuing gates.** → Mitigation: that is the specified park. Durable recovery already classifies `ci-exhausted` as `implementation-ci`. The exhausted line plus the blocked recipe name the resume path. Do not leave pre-merge unblocked; AC requires park-release so capacity is not stranded.
- **[Risk] `ci-exhausted` recipes talk about failing checks, but pre-merge gates never ran.** → Mitigation: the block **reason** names iteration-budget exhaustion. Kind stays `ci-exhausted` so recovery class is unchanged. Do not invent a new kind this change.
- **[Risk] A waiting stop on the 12th dispatch is misclassified as exhaustion.** → Mitigation: only the no-break fall-out is exhaustion (Decision 2). Covered by the in-loop waiting scenario.
- **[Risk] Additive `stop_reason` is ignored by old consumers.** → Mitigation: non-zero `process.exitCode` and the exhausted console line are the operator-visible floor. The field is for new consumers and logs.
- **[Risk] Dry-run still mutates GitHub if park is not gated.** → Mitigation: skip `setBlocked` / park-release under `--dry-run`, matching the auto-loop exhausted path. Still print the exhausted line so dry-run is honest.

## Migration Plan

No data migration. Existing in-flight issues left at `pipeline:pre-merge` without `blocked` are the pre-fix shape; a new advance invocation that still has budget will run pre-merge. Issues that hit the cap after this change park at `pre-merge` with `ci-exhausted`.

Rollback: revert the post-loop handler; #773 deferred finalize is independent and must stay.

## Open Questions

None. The user story listed continue / park / non-zero-exit; acceptance criteria pick non-zero-exit for all non-terminal stages and park only at `pre-merge`.
