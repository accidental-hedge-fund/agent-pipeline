## Context

Issue #499 shipped the `correction_event` ledger — an append-only record of *observable*
accepted corrections keyed for recurrence (`correction_key`) and idempotency (`correction_id`).
Issue #500 is the consumer: it must read that ledger and compile recurring corrections into
reusable-control proposals. The reuse surface already exists:

- `pipeline improve` (`core/scripts/improve.ts`) clusters five categories today
  (`review-finding`, `blocker`, `flaky-gate`, `token-waste`, `papercut`), each keyed on
  `(category, normalized signal)`, with a dry-run default, `--json`, `--apply`, once-per-run
  open-issue dedup, streaming line-by-line reads, and a shared `proposedTitle` helper.
- `papercut-auto-file` (`core/scripts/stages/papercut.ts`, #421) already implements the opt-in,
  off-by-default auto-file path — min-occurrence, open-issue dedup, per-window rate cap,
  sanitization, provenance, non-fatal — plus cross-host reconciliation hardening for the
  duplicate-issue failure mode.

This change adds one category and one auto-file entry, reusing both surfaces. The novel work is
that a correction cluster is **not** a text cluster: its identity comes from the bounded event
contract, and its output is a control-level proposal, not a bare recurrence report.

## Decision 1 — cluster on `correction_key`, not `normalizeSignal`

Every other `improve` category keys on `(category, normalizeSignal(freeText))`. Corrections
MUST NOT: #499 deliberately derived `correction_key` as a pure function of bounded fields
(`source_kind` + `failure_class` + `stage`) precisely so recurrence matching is deterministic
and un-gameable by prose. The compiler therefore keys correction clusters on
`correction:${correction_key}` and reads `normalizeSignal` on the free-text `correction` only
to pick a human-readable label/excerpt — never for identity.

Consequence: raw-text similarity and any enrichment LLM are **advisory-only**. Cluster
membership, dedup, and qualification are decided before and independent of any model call. A
test stubs the enrichment path to a no-op and asserts identical cluster membership and
qualification, so the authority boundary is enforced, not merely documented.

## Decision 2 — occurrence = distinct `correction_id`

The ledger guarantees replay/duplicate deliveries of the *same* correction share a
`correction_id` (#499 idempotency). The compiler counts occurrences by **distinct
`correction_id`** within a `correction_key` cluster, so a crash-retry that re-emits one
correction does not inflate the count. `--min-occurrences` for the `correction` category
defaults to **2** (matching the issue's "two distinct correction occurrences" requirement and
the auto-file `min` floor of 2), lower than the historical default of 3 for the telemetry
categories, because a correction is a stronger signal than a papercut: a human already judged
it worth correcting. Singletons stay visible in dry-run/JSON; only the file/apply gate uses the
threshold.

## Decision 3 — the control-level proposal and the graduation ladder

Each qualifying cluster proposes exactly one **next control level**:
`instruction | skill-rubric | eval | deterministic-gate | human-judgment`, or the explicit
sentinel `undetermined` when the evidence does not justify a level. The proposal follows the
graduation ladder `documented rule -> skill/rubric -> eval -> deterministic gate`: a control is
proposed at the *lowest* rung the evidence supports, and a correction whose class is provisional
taste, strategy, product judgment, or an authority boundary is proposed as `human-judgment` (or
`undetermined`) and is **never** hardened into an executable `eval` or `deterministic-gate`.

Where does the level come from? The `correction_event` already carries an optional
`proposed_control` (author-supplied at correction time). When present and consistent across the
cluster, it seeds the proposed level deterministically. When absent or mixed, the level is
`undetermined` unless an enrichment LLM proposes one — and an LLM-proposed level is rendered as a
*draft suggestion* in the issue body, still gated behind human triage, never auto-approved.
`failure_class` informs the ladder rung (e.g. `test-build-failure` / `eval-shipcheck-failure`
map toward `eval`/`deterministic-gate`; `spec-defect` toward `instruction`/`skill-rubric`;
review-finding taste toward `human-judgment`). Every proposal carries acceptance criteria and a
one-paragraph rationale tying the chosen rung to the cluster's evidence.

This is the guardrail the issue demands: model-generated prose is never treated as evidence of
human approval, and the compiler proposes — it does not install — controls.

## Decision 4 — reuse the papercut auto-file machinery verbatim

Correction auto-file is a second entry into the existing papercut auto-file path, not a parallel
implementation. It reuses the same dedup (open `[pipeline-improve]` issue titles), the same
per-window rate cap counted from GitHub-authored state, the same sanitization/provenance
(`agent-reported`, secret-redacted, injection-screened), and the same non-fatal totality. A new
opt-in `corrections` config block mirrors the `papercuts` auto-file keys
(`auto_file`, `auto_file_window_hours`, `auto_file_max_per_window`, `auto_file_min_occurrences`
with a floor of 2), off by default. The only correction-specific differences are the cluster
source (`correction_event` records keyed on `correction_key`), the occurrence semantics (distinct
`correction_id`), and the issue-body shape (the control-level proposal block).

## Decision 5 — single-host scope per #459, no false global-dedup claim

The papercut auto-file path was hardened for cross-host duplicate-issue convergence (#421). The
issue's acceptance criterion for #500 is narrower: **honor #459** by enforcing the supported
single-host constraint in runtime/docs rather than *claiming* global deduplication. This change
therefore documents the correction auto-file path as single-host-supported and does not assert a
cross-host global-dedup guarantee it has not separately verified for the correction source. If
the reused papercut reconciliation already converges duplicate `[pipeline-improve]` titles, that
convergence is inherited as-is; the spec does not extend a *new* cross-host guarantee beyond it.

## Decision 6 — read-only-plus-file authority boundary

The compiler inherits `improve`'s hard boundary: in dry-run it writes nothing; with `--apply`
(or auto-file) its only write is `gh issue create` for a `pipeline:backlog` issue. It never
queues, advances, approves, overrides, merges, deploys, or mutates code, labels (beyond the
single `pipeline:backlog` on creation), branches, worktrees, or existing issues/PRs. Out of
scope explicitly: editing repository instructions/skills/tests/CI, and auto-approving or
auto-queueing any generated issue.

## Risks / trade-offs

- **`proposed_control` sparsity.** Many historical `correction_event`s will lack a
  `proposed_control`, so early proposals will often be `undetermined`. Acceptable: an
  `undetermined` proposal is still a triage-ready backlog candidate with full evidence, and the
  field fills in as #499's emitters mature.
- **Threshold of 2 vs 3.** A lower file threshold risks more backlog noise. Mitigated by the
  stronger per-instance signal (a human already corrected it), the open-issue dedup, and the
  rate cap.
- **Graduation-ladder judgment is heuristic.** Mapping `failure_class` to a rung is a heuristic;
  the guardrail (never harden taste/judgment into a gate) is enforced by test fixtures, and the
  human triage gate is the backstop — the compiler proposes, humans dispose.
