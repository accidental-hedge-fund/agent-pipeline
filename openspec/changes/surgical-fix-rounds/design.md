## Context

The fix harness edits code to resolve review findings. Today `fix.md` carries one weak guardrail — "Do NOT change anything unrelated to the review findings" (step 3) — and no concept of *minimal* diffs or destructive-operation safety. Two converged-late runs trace directly to a fix round over-reaching:

- **#223** (`29db8fd3`): a fix broadening worktree *discovery* also widened the reclaim path's `git worktree remove --force` to worktrees outside the managed root → verified HIGH data-loss.
- **#214** (`ec30abb8`): a fix-1 lock change moved lock acquisition before the output dir existed → first-run ENOENT crash, HIGH.

Both escalated MED → HIGH *because* the fix touched more surface than the finding required. The cheapest place to stop this is at fix time, in the prompt the fix harness reads.

## Goals / Non-Goals

**Goals**
- The fix harness is instructed to produce the minimal, finding-scoped diff — refactors / scope-broadening / opportunistic cleanup are explicitly out of bounds during a fix round.
- Destructive/irreversible operations (force worktree removal, force push, branch/worktree deletion, the merge surface) get an explicit scope-or-justify guard so a fix can't silently widen their blast radius.
- A cheap, prompt-level pre-commit self-check catches the "I fixed a MED but introduced a HIGH" pattern before the diff is pushed.
- The discipline cannot silently regress (drift test) and is documented.

**Non-Goals**
- No replacement of the fix harness or model.
- No new pipeline stage and no programmatic diff-scanning gate in `fix.ts`: the #16 SHA-gate already re-reviews the pushed fix commit, so a *second* independent re-review at fix time is redundant. The self-check is a prompt instruction the harness executes on itself, not a new deterministic stage.
- No change to the review schema, the SHA gate, or the state-machine edges.
- The review-side handling of fix-introduced findings (risk-proportional blocking #232, demote-and-advance #233) is separate and already shipped.

## Decisions

**Decision: the discipline is prompt-level, not a new code gate.** The issue's out-of-scope is explicit that "a full independent re-review of every fix diff" is already covered by the SHA-gate. Prevention belongs in the prompt the fixer reads. This keeps the change to `fix.md` (+ optional constant) and tests — no new stage logic, no new failure mode in the loop. It mirrors how `implementing.md`/`plan_feedback` already carry behavioral discipline as prose.

**Decision: strengthen and promote, not merely keep, the "unrelated changes" rule.** The current step-3 line is too weak — it forbids *unrelated* changes but not over-broad *related* ones (a refactor "in service of" the fix passes it). The new instruction is explicit: minimal diff, no refactors, no broadening, no opportunistic cleanup, even when adjacent to the finding. It leads the Instructions section so it frames every fix.

**Decision: destructive-operation guard names the operations and the allowed scope.** Naming the concrete operations (`worktree remove --force`, `git push --force`/`--force-with-lease`, branch/worktree deletion, merge surface) is more actionable than an abstract "be careful with dangerous code". The guard requires the destructive path to be scoped to the **managed worktree root** or the **reviewed head** — exactly the constraint #223 violated (it removed worktrees *outside* the managed root). If a finding's fix genuinely requires touching such a path, the harness must state an explicit justification in its output.

**Decision: self-check is comparative, not absolute.** The harness compares its diff to the findings it was handed and withholds the push if any change looks like it introduces a *higher-severity* problem than the finding it resolves. This is the cheap version of the optional acceptance criterion — no severity-classifier code, just an instruction to the harness to reason about its own diff before committing. It is conservative-open: if the harness is unsure, it documents the concern in its output rather than blocking the run outright (the SHA-gate re-review remains the hard backstop).

**Decision: single-source the destructive-operation list only if it is reused.** If the list appears solely in `fix.md`, keep it inline. If a second consumer emerges (e.g. `test_fix.md`), promote it to a `DESTRUCTIVE_OPERATIONS` constant in `index.ts` injected via a `{{placeholder}}`, mirroring `SEVERITY_RUBRIC`. The drift test asserts on the rendered `buildFixPrompt` output either way, so the storage choice is invisible to the spec.

**Decision: drift test asserts on rendered output of `buildFixPrompt`.** Consistent with the existing prompt-loader tests (`assert.match(out, /…/)`). Each new assertion targets a distinct, stable phrase from each of the three instructions so removing any one bites a specific test.

**Decision: applies to every fix round, OpenSpec or not.** The discipline is unconditional (unlike the `{{spec_revision_instruction}}` block, which is OpenSpec-gated). #214 was not an OpenSpec run; the over-reach hazard is independent of OpenSpec.

## Risks / Trade-offs

- *Fix harness ignores the discipline (it is prose, not enforced).* → The #16 SHA-gate re-reviews the pushed fix commit, and risk-proportional blocking (#232) + demote-and-advance (#233) handle a fix-introduced finding on the review side. This change reduces the *rate* of such findings; it is not the only catch.
- *Over-constraining a legitimately broad fix.* → The guard does not forbid touching destructive paths; it requires scope/justification. A finding whose correct fix genuinely needs a force operation scoped to the managed root passes by stating that scope. The minimal-diff rule already carves out the OpenSpec spec-delta exception via the existing `{{spec_revision_instruction}}` block.
- *Self-check false-confidence.* → It is comparative and conservative-open; it never replaces the re-review, only front-runs the obvious escalations.
