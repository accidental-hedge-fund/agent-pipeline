## Context

PR #787 shipped `pipeline/stage-diagnostic@1` as the provider-neutral diagnostic transport and
closed projection into durable recovery dispositions (`recover` | `human_authority` | `capacity` |
`protocol_failure`). PR #814 removed review recurrence/ceiling from the human-authority path and
routed proven non-convergence through `review-findings` recovery. The remaining gap is repository-wide:

1. **No reviewable inventory** of the ~115 escalation sites and whether each is allowed to retry.
2. **Zero-retry infrastructure parks** still treat transient gh/push/worktree failures as product
   holds even when the engine owns the recovery surface.
3. **Four parallel taxonomies** (`BlockerKind`, `HumanInterventionKind`, `PreMergeOfframpClass`,
   `DurableBlockerClass`) plus loop `recovery_budgets` keyed by durable class create a
   fourth-and-a-half vocabulary that drifts from stage diagnostics.
4. **Safety history** (#622 data loss, #522 marker leakage) forbids blanket automated destructive
   recovery — dispositions must gate wrappers.

Issue #760 owns the vocabulary and site dispositions. #761 executes recovery recipes; #759 owns
the reconciler/attempt ledger; #647 owns genuine durable human questions. This design must leave
those seams clean.

## Goals / Non-Goals

**Goals:**

- One reviewable disposition table per escalation site, starting from the audit census.
- Drift guards so new blocker sites cannot land without a disposition.
- Evolve `STAGE_DIAGNOSTIC_REASON_CODES` (not a competing enum) so harness/gh failures classify
  mechanically from structured results.
- Exhaustive pure projections into existing taxonomies; loop budgets key the same closed set.
- Bounded retry wrappers only where disposition = `transient-retryable`.
- Keep integrity/attestation sites fail-closed; keep review rigor and authority gates intact.

**Non-Goals:**

- Implementing the reconciler/attempt-ledger (#759) or recipe execution owned by #761.
- Changing review blocking policy, severity thresholds, or merge/deploy authority.
- Auto-retrying review findings as blind replay or suppressing blocking findings.
- Cross-host distributed locks or new durable store schemas beyond additive reason members /
  projection fields.
- Re-litigating sites already fixed by #814 on the review authority path (still inventory them).

## Decisions

### 1. Evolve `pipeline/stage-diagnostic@1` in place — no competing reason enum

**Decision:** Add reason-code members (and projection rules) to the existing closed set in
`stage-diagnostic.ts`. Do not introduce a second top-level enum for "escalation reasons."

**Rationale:** Post-#787 reconciliation explicitly forbids a competing enum. Existing
`projectPipelineReasonCode` / `projectStageDiagnostic` are already the authority projection.

**Alternatives considered:**
- New `EscalationReasonCode` enum projecting into stage-diagnostic → rejected (two sources of truth).
- Free-form reason strings with a classifier → rejected (fails closedness and metrics).

**Additive members (minimum set; exact strings locked by implementation tests):**

| Member | Source signals | Durable projection sketch |
| --- | --- | --- |
| `transient-infra` (or map into existing `workflow-state` + disposition detail) | gh HTTP 5xx/rate-limit, network blips | recover / transient budget |
| `harness-timeout` | `HarnessResult.timed_out` | recover / engine defect or transient |
| `harness-contract` | `capture_error`, `oversize_argv`, `stdin_error`, output-contract fail | workflow-engine-defect |
| `repair-budget-exhausted` | local/durable budget hit after recovery | engine-owned terminal, never human |
| `external-wait` | upstream dependency / CI still running | recover/wait, not product judgment |
| `human-context-required` | underspec / missing operator context (≠ authority product decision) | may hold only under existing human-input protocol, not review-non-convergence |

Implementation MAY fold some of these into existing codes plus structured `detail` when projection
identity is already correct — the requirement is **mechanical classification + one vocabulary**,
not maximizing distinct strings. Prefer additive codes when projection today loses the class
(e.g. timeout vs generic harness-failure).

### 2. Site disposition is orthogonal to reason code

**Decision:** Define a closed `EscalationSiteDisposition`:

- `deliberately-fail-closed` — integrity/attestation; zero automatic retry at the site.
- `transient-retryable` — site-local bounded retry-with-backoff before escalation.
- `reconcile-owned` — site must not invent local recovery; the reconciler layer (#759) owns it.

Disposition answers "may this site retry before escalating?" Reason code answers "what happened?"
A site can be `deliberately-fail-closed` even when the reason is infrastructure (e.g. review-SHA
attestation actor unavailable → environment-auth / fail-closed).

**Inventory shape (normative table columns):**

`site_id` | `module` | `symbol/path` | `trigger` | `disposition` | `canonical_reason_or_projection` | `notes`

Starting inventory MUST include at least:

- `getGhActor` fail-closed sites (pre-merge SHA attestation, fix, shipcheck) — disposition
  per-site (attestation = deliberately-fail-closed; pure actor probe for non-attestation may be
  transient-retryable or environment-auth recover).
- Zero-retry push sites (fix, planning, pre-merge).
- Worktree-missing parks without rematerialize (fix, pre-merge).
- Label/gh mutation paths that currently park on first 5xx.
- Review non-convergence / recurrence / ceiling sites (reporting vs recovery already fixed by
  #814; inventory records disposition `transient-retryable` or engine-owned recovery, never
  human-authority-by-default).
- Pipeline format self-check parks (commit subject, impl ref, verdict sections).

### 3. Drift guards are static/source-level, not runtime heuristics

**Decision:** A unit test scans production TypeScript under `core/scripts/` for `setBlocked(`
call sites (and documented equivalent park emitters: direct `needs-human` transitions,
`emitHumanIntervention` without authority predicate). Each site must appear in a machine-readable
inventory module (e.g. `core/scripts/escalation-dispositions.ts`) keyed by stable site id.

**Rationale:** Runtime "best effort" classification reintroduces lossy taxonomies. Source drift
guards match existing patterns (`BLOCKER_RECIPES` exhaustiveness, stage-diagnostic projection
tests, prompt-loader drift guards).

**Alternatives considered:**
- Comment annotations only → rejected (not enforceable).
- AST plugin in CI only → acceptable as implementation detail of the same inventory test.

### 4. Wrappers second, dispositions first

**Decision:** Sequencing matches the issue: land inventory + projections + drift guards first
(pure documentation + tests, minimal behavior change), then enable wrappers only for sites marked
`transient-retryable`.

**Wrapper contracts (shared pattern):**

1. **gh transient** — reuse/extend `ghRun` + `isTransientGhError`; ensure label edits and reads
   that bypass `ghRun` are brought under it or a sibling wrapper. Acceptance case: 504 on label
   edit retries, never parks as product block solely from that blip.
2. **push** — before retry, re-sync currency (fetch + compare expected remote head); refuse retry
   when local HEAD is not the reviewed/owned head; never force-push.
3. **worktree rematerialize** — call existing `ensureManagedWorktree` after dirty-work check;
   map capacity/dirty refuse to typed kinds; do not force-destroy dirty trees (#622).
4. **format self-fix** — pipeline-owned formats only; rewrite and re-validate once (bounded);
   never rewrite human prose or review finding text.

All wrappers: injectable sleep/deps; charge a small local attempt count; on exhaustion escalate
with the **canonical reason**, not `needs-human` product judgment.

### 5. Derived taxonomies stay as projections, not deleted in this change

**Decision:** Keep `BlockerKind` / recipes (operator-facing unblock text),
`HumanInterventionKind` (metrics/reporting), `PreMergeOfframpClass` (scoreboard), and
`DurableBlockerClass` (budget keys) as **derived pure projections** from the canonical reason +
site context. Add exhaustiveness tests: every reason code maps; every projection member is
reachable or explicitly marked residual.

**Rationale:** Deleting taxonomies in one PR is high churn for consumers (scoreboard, intervention
summary, loop policy). Derivation + forbidding independent authority use is the safe migration.
`review-non-convergence` may remain a reporting dimension but MUST NOT be the authority
classifier (already partially shipped; this change hardens the drift guard).

Loop `recovery_budgets` / recovery policy keys SHALL be members of the same closed durable class
set projected from stage-diagnostic reasons — no orphan budget keys.

### 6. Authority predicate is the only path to human hold

**Decision:** Reaffirm #787/#814: human hold / `human_intervention` only when
`projectStageDiagnostic` yields `human_authority` with current candidate-bound authority evidence.
Add a drift guard that production call sites of `emitHumanIntervention` and `needs-human`
transitions either (a) pass through the authority predicate helper, or (b) are explicitly listed
as reporting-only / non-blocking metrics emitters.

Mechanical exhaustion → typed engine terminal / recover class, never human authority.

### 7. "Review findings are never auto-retried" clarified

**Decision:** Normative interpretation (post-#787):

- FORBIDDEN: blind re-run of the same review without candidate movement; suppress/override
  findings without operator override protocol; map review policy outcomes to human authority.
- ALLOWED: bounded `repair_pipeline_item` (or stage fix) then fresh review at the new candidate
  while budget remains — shipped recovery behavior.

## Risks / Trade-offs

- **[Risk] Inventory incompleteness** → Mitigation: start from audit census + ripgrep of
  `setBlocked` / `emitHumanIntervention`; drift guard fails CI on unknowns; residual sites default
  fail-closed until dispositioned.
- **[Risk] Over-retrying destructive surfaces** → Mitigation: disposition gate; dirty-work and
  currency checks; no force-push; no force worktree destroy; deliberately-fail-closed for
  attestation.
- **[Risk] Reason-code churn breaks consumers** → Mitigation: additive members only; unknown codes
  already project to protocol `workflow-engine-defect`; schema id stays `@1` if projection remains
  backward compatible, else document bump with migration note.
- **[Risk] Scope bleed into #759/#761** → Mitigation: `reconcile-owned` sites only document
  ownership; wrappers and recipes for those sites are out of scope.
- **[Risk] False "transient" classification of auth failures** → Mitigation: mechanical rules —
  auth/capability refusal maps to `environment-auth` / deliberately-fail-closed or recover-via-
  probe, never product judgment; 401 "bad credentials" transient retry stays at gh layer only
  (existing `isTransientGhError` policy), not human authority.

## Migration Plan

1. Land inventory module + disposition table + drift-guard tests (behavior-neutral except CI).
2. Land pure projection exhaustiveness (reason → durable class / intervention / offramp).
3. Enable wrappers site-by-site for `transient-retryable` inventory rows with injected-deps tests.
4. Regenerate `plugin/`; run `npm run ci`.
5. Follow-ups: #761 consumes budgets/recipes; #759 implements reconcile-owned; metrics
   (needs-human rate) read disposition table as denominator.

Rollback: revert the change branch; dispositions are additive; wrappers are feature-scoped and
can be re-dispositioned to `deliberately-fail-closed` without deleting the inventory.

## Open Questions

1. Exact additive reason-code strings vs mapping timeouts into existing `workflow-engine-defect`
   with structured detail — resolve during implementation by preferring the smallest additive set
   that keeps metrics and budgets non-lossy.
2. Whether `getGhActor` at shipcheck/fix is attestation-grade (fail-closed) or probe-grade
   (transient/environment-auth recover) — inventory MUST decide per call site using the caller's
   use of the actor (SHA attestation vs display/logging).
3. Whether format self-fix lives in `harness-step-verification` only or also a tiny shared
   helper — implementation choice; behavior is normative in the harness-step-verification delta.
)