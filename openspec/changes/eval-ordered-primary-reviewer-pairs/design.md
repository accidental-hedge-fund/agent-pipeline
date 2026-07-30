## Context

Today's eval runner (`core/scripts/evals/`) models a treatment as a single point in a
Cartesian product of axes (`TreatmentAxes` → `Treatment` → `treatment_id` slug). Each
cell invokes one harness for one stage (or a single-harness end-to-end sequence) from
fixture-frozen stage-entry artifacts (`stage-adapters.ts`). That design is correct for
comparing single-role treatments; it is the wrong shape for ordered primary→reviewer
selection (#600 / #601).

Production already has multi-role semantics: `configurable-harness-roles` and
`configurable-review-harness` resolve implementer vs reviewer from `.github/pipeline.yml`,
review policy partitions findings, and review parsing distinguishes strict / tolerant /
unparseable verdicts (#606). The eval runner does not yet orchestrate those roles as one
experimental unit with live handoffs.

Constraints carried forward:

- No production GitHub writes (`stage-eval-runner`, eval-mode `gh` surface + boundary shim).
- Fake-backed unit tests; no live model/network/git in CI.
- Results contract is append-only; new detail keys are additive.
- Rigor over latency: paired modes measure the real review/fix loop, not a demoted
  single-pass substitute.
- Edit `core/`, regenerate `plugin/` in the same change.

## Goals / Non-Goals

**Goals**

- Represent ordered primary/reviewer pairs as first-class treatments with stable identity.
- Execute a faithful pair loop (`implementing-paired`) and the deployable multi-stage
  graph (`pipeline-paired`) with live handoffs.
- Reuse production prompt builders, output gates, and review-policy partitioning so eval
  and production contracts cannot drift.
- Attribute timeout, auth, and preflight failures to the correct role without scoring
  them as quality.
- Emit pair evidence sufficient for later campaign reporting (#604) without implementing
  the campaign workflow here.

**Non-Goals**

- Campaign CLI, corpus fingerprints, capability discovery, or auto-writing pipeline.yml
  (#602–#604, #653–#655).
- Replacing deterministic graders with a single model score.
- Changing Cartesian single-role experiments or production stage entry points' GitHub
  side effects (those stay behind the eval surface).
- Inventing a third review after adversarial fix-2.

## Decisions

### D1. Two mutually exclusive treatment forms on the same `treatments` field

A manifest's `treatments` value is either:

1. **Cartesian form** (existing): an object whose keys are axis names and values are
   non-empty `string[]` — today's behavior, unchanged.
2. **Named-pairs form** (new): an object with a discriminant (e.g. `form: "named-pairs"`)
   and a `pairs` array. Each pair has a stable unique `id` and role objects `primary` and
   `reviewer`, each carrying role-local coordinates (`harness`, optional `model`,
   optional `effort`, and other allowlisted role fields such as `executor` / `params`
   when needed).

Validation rules (fail closed, name the field):

- Mixing form shapes (axis arrays and `pairs` / unknown dual fields) → reject.
- Duplicate `id` → reject.
- Missing `primary` or `reviewer` → reject.
- Unknown field on a role coordinate → reject.
- Empty `pairs` → reject.
- Paired modes require named-pairs form; named-pairs form requires a paired mode
  (`implementing-paired` or `pipeline-paired`).

*Alternative rejected:* encode pairs as Cartesian product of `primary_harness` ×
`reviewer_harness` axes. That recreates invalid cross-products of harness-specific model
names and loses explicit pair identity.

*Alternative rejected:* two separate experiment manifests (one implement, one review)
joined offline. That cannot measure live handoffs or fix convergence.

### D2. Pair identity and plan expansion

For named pairs, expansion is fixtures × pairs × replicates (not Cartesian axes).

- `treatment_id` is the pair's stable `id` (operator-chosen, unique in the manifest).
- The plan cell stores the full pair coordinates: `{ id, primary: {...}, reviewer: {...} }`.
- `cell_id` remains deterministic from experiment / fixture / treatment_id / replicate.

Cartesian expansion path is untouched when the form is Cartesian.

### D3. Modes: `implementing-paired` and `pipeline-paired`

| Mode | Graph |
|------|--------|
| `implementing-paired` | primary implement → reviewer review-1 → (if blocking) primary fix-1 → reviewer re-review |
| `pipeline-paired` | primary plan → reviewer plan-review → primary plan revision → primary implement → reviewer standard review → (blocking) primary fix-1 → reviewer adversarial review → (blocking) primary fix-2 |

Existing modes stay single-role and Cartesian-only.

After fix-2, **no third review** is fabricated. Review-2 / pre-fix-2 findings are labeled
separately from the final post-fix-2 worktree state used for implementation grading.

### D4. Live handoffs replace fixture-only review input for paired modes

In paired modes, stage-entry fixtures still supply task input and entry context for the
first stage, but intermediate stages consume **artifacts produced earlier in the same
cell**:

- plan text / structured plan
- plan-review feedback
- revised plan
- current git diff (real worktree diff after implement/fix)
- formatted review-1 context and blocking findings for fix

The reviewer MUST see the actual primary diff. Using only
`fixture.stage_entry_artifacts.review` as the review body would measure the wrong thing
and is forbidden for paired modes.

### D5. Reuse production prompt builders and output gates

Paired stages build prompts through the same production builders / templates the live
pipeline uses (planning, plan-review, review standard/adversarial, fix), with placeholders
filled from live handoff state + fixture task input. Output parsing reuses production
verdict parsers and review-policy partitioning.

Implementation and fix prompts may append **only** an eval-specific execution override:
no commit, no push, no production GitHub mutation — so the agent stays inside the eval
worktree without changing the production content contract.

*Alternative rejected:* keep eval-local one-liner stage adapters for paired modes. That
reintroduced the #606 contract drift class for multi-role runs.

*Alternative rejected:* call full production stage entry points that assume live PR/issue
labels. Paired eval stays worktree-local and uses the eval `gh` surface; it reuses pure
prompt/policy/parse pieces, not production label transitions.

### D6. Slot coupling and reviewer overrides

`pipeline-paired` resolves implementer/reviewer slot settings the same way production
does for the repository config under test (pipeline.yml `harnesses`, `review_harness`
model/effort/prompt-delivery), then **overlays** the cell's pair coordinates as the
experimental treatment. Conflict rules match production (conflicting reviewer declarations
fail closed). Pair coordinates always win as the experimental variables; config supplies
non-overridden slot defaults and structured reviewer settings when the pair leaves a field
unset.

### D7. Timeout, auth, and result classes

- One per-cell wall-clock budget from the manifest `timeout` spans **all** role
  invocations in the pair loop. Exceeding it → `result_class: "timeout"`.
- Auth/preflight failure on a primary invocation → `auth_error` (or infra for pure
  preflight config) with `detail.failed_role: "primary"`.
- Same for reviewer with `failed_role: "reviewer"`.
- Malformed review output: intermediate unparseable steps (e.g. review-1) still trigger
  fix with explicit `review_verdict_parse: "unparseable"`; they are **not** approval and
  do not clear blocking findings. Blocking disposition for "unparseable" follows
  production: treat as non-approval / blocking contract failure, never as empty findings
  pass. For `implementing-paired`, if the **final** re-review remains unparseable or
  still has blocking findings, the cell is **not** `completed` — it is recorded as
  `infra_error` with an explicit non-approved final-review disposition and full loop
  evidence, so it is excluded from quality grading and completion reliability.

### D8. Isolation boundary lifecycle for multi-invocation cells

Install the eval root instruction contract and PATH deny-shim once per cell before the
first harness invocation. Keep them active across every primary and reviewer invocation.
Restore instruction paths and remove shim **only** when collecting clean changed-path /
check evidence and at teardown — never between intermediate stages in a way that lets
repo workflow skills reassert control mid-loop.

### D9. Evidence and grading

Cell `detail` (additive) for paired cells includes at least:

- `pair_id` / treatment pair identity
- `primary` / `reviewer` coordinates as executed
- `fix_invoked` (and which fix rounds)
- `blocking_findings_before` / `blocking_findings_after` (per applicable review step)
- per-review parse provenance (strict | tolerant | unparseable)
- stage timeline / duration
- role of any non-completed failure

Deterministic `implementation-fix` grading runs on the **final** worktree state after the
pair loop ends (post last fix, or post implement if no fix). Review grades may still use
seeded defects for dedicated review fixtures when applicable; for implementation-paired
cells the primary quality signal is implementation grading of the final tree.

Reporting/summary surfaces pair identity and the evidence fields above alongside existing
quality, duration, and reliability rates. Comparative pairing against a baseline remains
by `treatment_id` (the pair id).

### D10. Plugin mirror paths in fixtures

When a fixture's allowed-change boundary is used for tasks that edit `core/`, generator
rules require a matching `plugin/` mirror update. Validation SHALL allow
generator-owned paths under `plugin/` in `allowed_change_paths` (and shall not count those
paths as out-of-scope solely for living under `plugin/`). Non-generator noise under
`plugin/` remains subject to normal boundary rules if not listed.

## Risks / Trade-offs

- **[Risk] Prompt-builder coupling to live stage modules** → Mitigate by importing pure
  builders/templates/parsers only; keep eval executor as the orchestrator; tests assert
  no mutating `gh` calls.
- **[Risk] Long `pipeline-paired` cells exhaust timeout or cost budgets** → Timeout is
  honest (whole loop); operators set higher `timeout` for pipeline-paired manifests;
  `implementing-paired` remains the cheaper mode for pair screening.
- **[Risk] Unparseable review silently zeroed** → Explicit provenance + non-approval
  rule; regression tests for malformed output.
- **[Risk] Boundary restored too early, mid-loop** → Lifecycle tests: contract present
  before every invocation; restore only at evidence collection.
- **[Risk] Cartesian regressions** → Keep expansion/validation paths branched by form;
  existing manifest tests must remain green without edits to fixtures.
- **[Trade-off] Named pair ids are operator-chosen** rather than hashed from coordinates
  → readable baselines for #604; uniqueness enforced at validation.

## Migration Plan

- Additive only: existing manifests, modes, and records keep working.
- No re-grade of historical experiments required.
- After implementation: regenerate `plugin/` via `node scripts/build.mjs`; `npm run ci`.
- Rollback: remove paired modes/form; Cartesian path is independent.

## Open Questions

- Exact JSON discriminant field name (`form: "named-pairs"` vs `treatment_form`) — pick
  one in implementation and lock with schema tests; default recommendation:
  `form: "named-pairs"` + `pairs: [...]`.
- Whether `implementing-paired` re-review after fix uses the same standard review prompt
  as review-1 (recommended: yes, same policy) vs a lighter re-check — recommend same
  standard review builder for measurement stability.
- Depth of plan-revision after plan-review when plan-review has no blocking findings —
  recommend skip revision and proceed to implement with the original plan, recording
  `plan_revision_invoked: false`.
