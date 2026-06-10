## Context

OpenSpec authoring happens at planning time (`advanceOpenspec`, `core/scripts/stages/planning.ts`), before review. The state machine has no edge from review back to planning — the lowest a review bounces is a fix round (`review-1 → fix-1`, `review-2 → fix-2`). Fix rounds edit code only.

The fix prompt (`fix.md` line 25) actively discourages touching anything "unrelated to the review findings." The spec section (`specContextSection`, `prompts/index.ts:317-324`) frames the spec deltas as immutable truth ("must satisfy"), not a document the harness may revise. The pre-merge archive (`maybeArchiveOpenspec`, `pre_merge.ts:383-441`) calls `openspec archive` unconditionally on any active change, without checking whether the change's spec text still matches the implementation.

## Goals / Non-Goals

**Goals:**
- Fix rounds may (and are instructed to) update spec deltas when a finding's resolution changes behavior described by the active change's `specs/**`.
- The fix harness re-validates the change after any spec update (`openspec validate <id>`) before committing.
- The pre-merge stage detects and blocks on code-spec divergence before archiving, providing an explicit error rather than silently archiving a stale delta.
- The fix path remains conservative: if no finding implies a spec-level change, the harness makes no spec edits (instruction is conditional on behavior change).

**Non-Goals:**
- A new state-machine edge from review to planning (Option b from the issue). This is deferred to v1.1.0 if Option a proves insufficient.
- Semantic diff between spec text and code (the guard uses a structural heuristic: did implementation files change while `specs/**` did not, and did the reviewer flag divergence?).
- Changing how spec deltas are loaded or injected into the review prompt.

## Decisions

**Decision: Prompt-only instruction for fix rounds (no code machinery to detect behavioral change)**
Automatically detecting whether a code change alters behavior described by a spec would require understanding both code semantics and spec semantics — well beyond a structural check. The harness already reasons over both the review findings and the spec delta text; instructing it to update the spec when the finding implies a behavioral change is the appropriate leverage point. The existing `openspec validate <id>` structural check provides the deterministic backstop.

**Decision: Reframe `specContextSection` from "must satisfy" to "must stay consistent with"**
"Must satisfy" treats the spec as immutable truth — a correct framing when the spec is right, but it actively misleads the fix harness when the finding implies the spec itself was wrong. "Must stay consistent with" preserves the constraint (don't drift without reason) while permitting a deliberate revision. This is a single-line wording change with no structural effect on how the section is rendered.

**Decision: Pre-merge guard uses a structural heuristic (not full semantic analysis)**
Full semantic diff between spec text and code is out of scope (and likely intractable). The heuristic is: developer/fix commits on this branch touched implementation files under `core/scripts/`, AND the change's `specs/**` files were NOT among the changed paths, AND the most recent review verdict contained a finding flagging spec divergence. All three conditions present → block with a descriptive reason before archiving. Missing any one → allow archive (conservative-open rather than conservative-closed, to avoid false positives on fix rounds that correctly left the spec unchanged).

**Decision: Structural-only `openspec validate <id>` after spec revision in fix rounds**
The existing structural validation (SHALL + `#### Scenario:`) is the gating check. Whether the revised spec semantically captures the new behavior is a reviewer concern (the #16 SHA gate will trigger a re-review on the fix commit that updates the spec).

**Decision: Regression test via existing deps/fake seam pattern**
`maybeArchiveOpenspec` takes `getForIssueFn` as an optional dep. The pre-archive consistency check will take the same pattern (injectable fakes for worktree state, branch diff output, and latest reviewer verdict). No real git or openspec subprocess in the unit test.

## Risks / Trade-offs

- [Risk: Fix harness ignores the spec-revision instruction] The structural `openspec validate <id>` check (already mandatory) and the re-review triggered by the #16 SHA gate provide two layers of catch. → Mitigation: the instruction is OpenSpec-conditional and explicit; the pre-merge guard is the hard backstop.
- [Risk: Pre-merge guard produces false positives on valid "spec didn't need to change" fixes] The three-condition heuristic (impl changed + spec unchanged + reviewer flagged divergence) reduces false positives to cases where the reviewer was wrong. In that case the `--override` escape hatch (review-severity-policy, PR #86) lets the maintainer record an audited disposition. → Mitigation: document this in the block message.
- [Risk: "Must stay consistent with" framing causes the fix harness to silently drop spec constraints] The revised wording still says "consistent with" — constraints remain. The instruction only adds a permission (and instruction) to update when the finding forces a behavioral change. → Mitigation: the spec-revision instruction is conditional on a finding implying a behavioral change; the general case is unchanged.
