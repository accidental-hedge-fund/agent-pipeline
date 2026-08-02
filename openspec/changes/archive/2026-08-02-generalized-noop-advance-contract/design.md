## Context

Several stages independently special-case the same product outcome:

| Instance | Stage | Today’s private path |
|----------|--------|----------------------|
| #698 | pre-merge auto-fix | `noop-clean` → delta re-verify → proceed or still-broken recipe |
| #714 | pre-merge OpenSpec archive | shared active-set coherence so skip/no-candidates cannot disagree with residual-active block |
| #747 | pre-merge delta | category **partition** (not all-or-nothing veto) + residual human disposition; clean no-commit still re-verifies |
| Fix no-commits | fix-1 / fix-2 | override-empty skip; does-not-reproduce declarations; external-commit when HEAD ≠ reviewed SHA |
| #588 | planning → implementing | empty implementer range false-blocks when accepted OpenSpec deliverable already lives in the planning commit |

Related shared pieces already exist and MUST be reused, not forked:

- `core/scripts/harness-round.ts` — shared implementer-round skeleton (headBefore → invoke → salvage → verify callbacks).
- Fix pure helpers: `decideExternalCommitAdvance`, `computeEffectiveBlockingSet`, `decideDoesNotReproduceAdvance`.
- Pre-merge: `noop-clean` status, durable attempt markers, partition allowlist.
- #787 autonomous recovery: `no-commits` maps toward `implementation-ci`; needs a deterministic first recipe that does not invent another stage-private marker.

Constraints:

- Fail closed when HEAD does **not** satisfy the stage goal.
- No empty-commit invention; no review-rigor reduction; no auto-merge.
- Unit tests use deps injection only (no real network/git/subprocess).
- Preserve post-#628 pre_merge modularization (`pre-merge-autofix`, `pre-merge-sha-gate`, …).
- #588 regression must exercise **fresh process / re-entry**, not only an in-memory helper.

## Goals / Non-Goals

**Goals:**

1. One stage-agnostic **evaluation contract** for “no new commit after salvage → is stage goal already true at HEAD?”
2. Behavior-preserving migration of the special cases above onto that contract.
3. Attested evidence on advance; typed escalation when unsatisfied.
4. Same verifier for normal stage execution and #787 recovery re-entry (first deterministic recipe).
5. Regression suite that replays #698 / #714 / #747 / #588 (and retains fix-stage recipes).

**Non-Goals:**

- Expanding auto-fix category allowlist or changing review_policy thresholds.
- Replacing salvage, dirty fail-closed, format/test gates, or CI gates.
- Unifying *all* stage outcome types into one enum (only the no-new-commit / goal-satisfaction decision).
- Inventing empty commits or weakening OpenSpec archive fail-closed rules when active changes remain.

## Decisions

### Decision 1 — Shared pure decision + stage-supplied goal checks

**Choice:** Introduce a small shared module (working name: `noop-advance` / `stage-goal` under `core/scripts/`) that owns:

1. **Inputs (injected):** `headBefore`, `headAfter`, worktree cleanliness / salvage result, stage id, optional reviewed SHA / attempt markers, and a **stage goal checker** callback (or pluggable check list) that returns `satisfied | unsatisfied` with a machine-readable **rationale class** and human-readable note.
2. **Preconditions:** only runs the goal check when `headAfter === headBefore` (or equivalent no-new-commit) **and** salvage did not create a commit (dirty salvage remains stage/salvage-owned).
3. **Outputs:** a closed decision:
   - `advance` — goal satisfied; caller advances / continues and **must** record attested evidence (stage, HEAD SHA, rationale class, short note).
   - `escalate` — goal not satisfied; caller uses existing typed block path (`no-commits`, `needs-human`, archive-invalid, etc.) with reason text that may include the checker’s note.
   - `not-applicable` — not a clean no-new-commit path (commit range non-empty, salvage succeeded, missing inputs) so existing stage logic continues unchanged.

**Why:** Stages differ in *what* “goal” means, not in the control skeleton. Centralizing only the skeleton stops the fifth private reimplementation while keeping product rules stage-owned.

**Alternatives:**

- Single global goal definition for all stages → wrong (archive ≠ fix findings ≠ implement deliverable).
- Only document the pattern without code → class will escape again.
- Force every stage to invent empty commits when “done” → dishonest and trips surgical-fix / commit gates.

### Decision 2 — Stage goals are explicit check functions, not freeform prose

**Choice:** Each migrated consumer supplies one or more **deterministic checks** (pure or deps-injected) that answer “does HEAD already satisfy this stage’s goal?” Examples:

| Consumer | Goal satisfaction (examples) |
|----------|------------------------------|
| Fix override-empty | Effective blocking set empty after live override subtract → satisfied *before* harness; still modeled as “no work left” advance |
| Fix does-not-reproduce | Valid declarations cover every invoked finding at current HEAD |
| Fix external-commit | HEAD ≠ reviewed SHA (and existing carve-outs) |
| Pre-merge noop-clean | Re-verify / HEAD check: no residual blocking allowlisted findings (partition residuals still human-required when present) |
| Pre-merge archive | Active-change set empty **or** archive action already produced coherent pass for this head evaluation (no skip-then-block dual signal) |
| Planning implement (#588) | Declared deliverable present (e.g. accepted OpenSpec change under `openspec/changes/<id>/` from planning commit), worktree clean relative to implement headBefore, relevant gates green |

**Why:** Keeps fail-closed property testable; avoids “model says it’s fine” as the sole satisfaction proof for this class.

**Note:** Override-empty is a **pre-harness** skip; still an instance of “goal already satisfied / nothing to do.” The shared module MAY expose both `evaluatePreHarnessNoWork` and `evaluatePostHarnessNoNewCommit` entry points, or one API with a `phase` flag — implementation choice, same contract.

### Decision 3 — Evidence is mandatory on advance; markers stay stage-owned where bounds require them

**Choice:** On `advance`, the shared helper returns a structured **evidence payload** the caller must persist via existing channels (trusted pipeline comment, `gate_result` / event sink, evidence bundle field — whichever the stage already uses). Payload includes at least: stage, issue number (if known), HEAD SHA, rationale class, and short note.

Durable **one-attempt** markers for pre-merge noop-clean remain pre-merge-owned (existing attempt-started / noop-clean comments). The shared contract does **not** invent a second parallel marker scheme. Recovery (#787) **reuses** the same satisfaction evaluation; it does not add a recovery-only bypass flag.

**Why:** Auditability without proliferating sentinel formats.

### Decision 4 — Behavior-preserving migration order

**Choice:** Migrate in this order so each step keeps green regressions:

1. Extract shared decision + evidence shape; unit-test pure matrix in isolation.
2. Fix-stage: route external-commit / does-not-reproduce / (post-harness) no-commit fall-through through shared decision; keep existing pure helpers as check implementations or thin adapters.
3. Pre-merge auto-fix `noop-clean` + re-verify terminal disposition through shared decision (status strings may stay for call-site clarity).
4. Planning implement #588 goal check + fresh re-entry regression.
5. Archive coherence: ensure residual satisfaction/empty-active evaluation is expressed as a stage goal check used by the same pre-merge path (do not reopen #714 dual-outcome bugs).
6. Wire #787 `implementation-ci` / `no-commits` first recipe to call the same evaluation with the **current stage’s** goal checker.
7. Delete dead private duplicates only when tests prove parity.

**Why:** Lowest risk; each historical false-block stays covered.

### Decision 5 — Recovery first recipe charges no model budget on satisfied HEAD

**Choice:** When autonomous recovery (or blocked-recipe path) selects the deterministic goal-satisfaction recipe for `no-commits` / `implementation-ci`:

- Run shared evaluation with the stage goal checker for the item’s current stage.
- If `advance`: record evidence, clear/continue per existing recovery redispatch rules, **do not** invoke model-repair or consume repair-pipeline budget for this recipe.
- If `escalate` / unsatisfied: fall through to next configured recipe or fail-closed park — **do not** treat unsatisfied as success.

**Why:** Matches post-#787 reconciliation text on the issue; prevents charging repair budget for already-correct trees.

### Decision 6 — #588 fresh re-entry regression

**Choice:** Add a test that simulates **re-entry** into implementing (or the implement phase of planning) as a new process would: marker/state as after planning commit with OpenSpec deliverable present, implement harness reports success with no new commit, clean tree → shared check satisfies → advance to post-implement steps (test gate / PR / review-1 per existing path) without empty commit and without `no-commits` block. A second assertion proves that removing the goal check reintroduces the block.

**Why:** Issue explicitly rejects helper-only coverage.

## Risks / Trade-offs

- **[Risk] Over-generalization weakens a stage’s fail-closed path** → Mitigation: default unsatisfied; each check must be explicit; regression bites when goal check is skipped.
- **[Risk] “Satisfied” false positive advances broken work** → Mitigation: checkers use deterministic HEAD/artifact/review evidence only; re-verify remains real for pre-merge; no “no-op ⇒ approve” without check.
- **[Risk] Large pre-merge / fix diffs fight #628 modularization** → Mitigation: shared module is thin; stages keep product policy; no re-merge of pre_merge monolith.
- **[Risk] Duplicate evidence noise (comment + event)** → Mitigation: prefer extending the stage’s existing audit comment/event rather than a third channel.
- **[Trade-off] Two entry points (pre-harness vs post-harness)** slightly less elegant than one → Acceptable; product phases differ and merging them obscures override-empty vs post-run DNR.

## Migration Plan

1. Land shared module + pure tests (no stage wiring) behind exports used only by tests.
2. Wire fix → pre-merge → planning implement → recovery per Decision 4.
3. Keep old function names as wrappers during migration if needed; remove wrappers only when unused.
4. `node scripts/build.mjs` for `plugin/` if any mirrored paths change; full `npm run ci`.
5. Rollback: revert the change set; no data migration (evidence comments are additive).

## Open Questions

1. Exact module filename and export names — left to implementation (prefer existing `stages/` helper style or top-level `core/scripts/` next to `harness-round.ts`).
2. Whether override-empty pre-filter is routed through the shared module in v1 or only post-harness no-new-commit paths — either is acceptable if acceptance criteria and regressions hold; prefer including both if the API stays small.
3. Whether archive coherence (#714) needs a code call into the shared module vs. documentation that “empty active set” is a stage goal already enforced by the archive guard — prefer a thin adapter so #714 scenario appears in the shared regression table.
