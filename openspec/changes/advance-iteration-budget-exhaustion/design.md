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

- Distinguish loop-exhausted from loop-broke with an explicit fall-through flag (`i === MAX_ITERATIONS` after a `for` that `break`s set the flag false). Export `shouldHandleNonterminalIterationExhaustion` next to `shouldRunDeferredTerminalFinalize`.
- Make non-terminal exhaustion operator-visible (distinct line, no `done —`) and machine-visible (non-zero `process.exitCode` after `run_complete`, typed `stop_reason`).
- At `pre-merge`, park with the existing `ci-exhausted` mechanical shape, an iteration-budget reason, and attempted park-release.
- Keep in-loop auto-loop continuation and auto-loop exhaustion unchanged; do not double-park.
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

**Choice:** Hoist the loop index (`let i = 0; for (; i < MAX_ITERATIONS; i++)`) and set `iterationBudgetExhausted = (i === MAX_ITERATIONS)` after the loop. Every explicit `break` leaves `i < MAX_ITERATIONS`, so the flag is false. Export a pure helper `shouldHandleNonterminalIterationExhaustion({ iterationBudgetExhausted, finalStage })` analogous to `shouldRunDeferredTerminalFinalize`. Do **not** put `dryRun` on this helper: dry-run still prints the exhausted line; park/`setBlocked` stay gated on `!dryRun` at the call site.

**Why:** An in-loop `waiting` at pre-merge (CI still running) is a legitimate stop and already specified to end without error. Treating that as budget death would block issues that are actually waiting on CI. The #1243 bug is specifically "no break, cap hit, remaining gates unrun."

**Alternatives considered:**

- Treat `transitions === MAX_ITERATIONS` as exhaustion even after a waiting break on the last iteration → over-closed; that last iteration did run the stage.
- Count only advancing iterations → the cap is dispatches, not advances; keep matching the loop bound.

### 3. Reuse the ci-exhausted kind mapping; do not reuse the auto-loop reason prefix

**Choice:** Extract the stage-to-blocker mapping from `autoLoopExhaustedBlockedOutcome` into a shared helper (pre-merge → `ci-exhausted` + offramp `ci-failed`; any other wait → `needs-human`). Keep `autoLoopExhaustedBlockedOutcome` on that mapping with its existing `auto-loop budget exhausted at <stage>: …` reason. The new pre-merge path calls the same mapping with a distinct reason that names **iteration-budget** exhaustion (issue number and stage). Call `setBlocked` and `maybeReleaseWorktreeOnPark` with that outcome. Do not add a `BlockerKind`. Do not call `autoLoopExhaustedBlockedOutcome` unchanged on this path.

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

**Choice:** Add unit tests that drive `runAdvance` with injected `AdvanceDeps` so the loop advances until the cap at `pre-merge` and at `review-1` with `auto_loop` disabled. Assert against persisted `events.jsonl` (not only a mocked `finalizeRun` call): `schema_version` stays `1`, `final_state` is the pre-park stage, `stop_reason` is `iteration-budget-exhausted`. Also assert: no `done —` line, exhausted line present, `process.exitCode !== 0`. Second test: pre-merge path calls `setBlocked` with `ci-exhausted` and an iteration-budget reason, and `releaseParkedWorktree` is attempted. Keep existing `deferred-terminal-finalize.test.ts` assertions. No live network, git, or subprocess.

**Why:** The #1243 log is exactly "12 transitions, done, exit 0, no blocker." A pure helper test is necessary but not sufficient; the wiring in `runAdvance` is the hole. `pipeline logs --events --follow` ends on a persisted `run_complete` line (`isAdvanceRunCompleteLine` keys on `type` only).

### 6. Auto-loop in-loop path stays first; the new handler never double-parks it

**Choice:** Leave the in-loop auto-loop block (`isAutoLoopEligible` / `canAutoLoopContinue` / `autoLoopExhaustedBlockedOutcome` / `buildAutoLoopExhaustedComment`) byte-behavior identical. The new handler runs only when `iterationBudgetExhausted === true` (for-loop fall-through). An in-loop auto-loop exhaustion `break` therefore never enters the new handler. Do not post auto-loop exhausted comments from the new path. If auto-loop `continue`s on the last slot and the `for` condition then fails, that is MAX_ITERATIONS death, not auto-loop budget death: apply the incomplete-invocation treatment (iteration-budget reason at pre-merge). That does not change auto-loop continuation while iterations remain.

**Why:** The proposal said auto-loop is unchanged while stating a broad post-loop rule. Without an explicit gate, a second park or an auto-loop reason on a MAX_ITERATIONS death would alter `#149`. Fall-through after a last-slot `continue` is the iteration cap winning — that cap already consumes auto-loop continues today; only the silent `done` / exit 0 is the bug.

**Alternatives considered:**

- Skip the new handler whenever `auto_loop.enabled` is true → rejected. A #1243-shaped advance with auto-loop configured but never engaged (`autoLoopRoundsSpent === 0`) would still print `done` and exit 0.
- Convert last-slot auto-loop continue into the auto-loop exhausted comment → rejected. Auto-loop rounds/wallclock may still have budget; MAX_ITERATIONS is the budget that died.

### 7. Snapshot `finalStage` before park; `run_complete.final_state` stays the stage

**Choice:** Capture `exhaustionStage = finalStage` before `setBlocked` / park-release. Pass that snapshot to `finalizeBundle` / `finalizeRun`. Never assign `finalStage = "blocked"`. `run_complete.final_state` on this path is the pre-park stage (`pre-merge`, `review-1`, …). `stop_reason: "iteration-budget-exhausted"` is the incomplete marker.

**Why:** `finalizeRun` copies `bundle.finalState`. If park mutates labels and the controller re-reads them, consumers would see `blocked` and miss that gates at `pre-merge` never ran.

### 8. Non-zero exit through `process.exitCode` after `run_complete`

**Choice:** Use the existing `process.exitCode = 1` seam already used when a pipeline label is missing (`runAdvance` ~line 1020). Set it only after the inner `finally` writes `run_complete` (same place as today's `done —` line). Never call `process.exit()`. `shouldHandleNonterminalIterationExhaustion` does **not** take `dryRun`: dry-run still prints the exhausted line and skips GitHub park. `#773` remains independently false under dry-run.

**Why:** Immediate `process.exit(1)` would skip `finalizeRun`, terminal-log tee stop, and collector cleanup. Tests already observe `process.exitCode` without a subprocess.

## Risks / Trade-offs

- **[Risk] Parking `pre-merge` with `ci-exhausted` makes a naive second `/pipeline N` hit already-blocked instead of continuing gates.** → Mitigation: that is the specified park. Durable recovery already classifies `ci-exhausted` as `implementation-ci`. The exhausted line plus the blocked recipe name the resume path. Do not leave pre-merge unblocked; AC requires park-release so capacity is not stranded.
- **[Risk] `ci-exhausted` recipes talk about failing checks, but pre-merge gates never ran.** → Mitigation: the block **reason** names iteration-budget exhaustion. Kind stays `ci-exhausted` so recovery class is unchanged. Do not invent a new kind this change.
- **[Risk] A waiting stop on the 12th dispatch is misclassified as exhaustion.** → Mitigation: only the no-break fall-out is exhaustion (Decision 2). Covered by the in-loop waiting scenario.
- **[Risk] Additive `stop_reason` is ignored by old consumers.** → Mitigation: non-zero `process.exitCode` and the exhausted console line are the operator-visible floor. The field is for new consumers and logs.
- **[Risk] Dry-run still mutates GitHub if park is not gated.** → Mitigation: skip `setBlocked` / park-release under `--dry-run`, matching the auto-loop exhausted path. Still print the exhausted line so dry-run is honest. The incomplete helper stays true under dry-run; only mutations are gated.
- **[Risk] Auto-loop and the new handler both park the same issue.** → Mitigation: Decision 6. In-loop auto-loop exhaustion `break`s, so `iterationBudgetExhausted` is false. The new path never posts `buildAutoLoopExhaustedComment`.
- **[Risk] Park label mutation reports `run_complete.final_state: "blocked"`.** → Mitigation: Decision 7. Snapshot `finalStage` before park; do not overwrite it.

## Migration Plan

No data migration. Existing in-flight issues left at `pipeline:pre-merge` without `blocked` are the pre-fix shape; a new advance invocation that still has budget will run pre-merge. Issues that hit the cap after this change park at `pre-merge` with `ci-exhausted`.

Rollback: revert the post-loop handler; #773 deferred finalize is independent and must stay.

## Open Questions

None. The user story listed continue / park / non-zero-exit; acceptance criteria pick non-zero-exit for all non-terminal stages and park only at `pre-merge`.
