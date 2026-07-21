# Design — risk-triggered design-interrogation gate (#436)

## Context

The pipeline's rigor comes from independent gates over *artifacts*: a plan (plan-review) and a diff
(review-1 / review-2). Between them sits `implementing`, where the material design decisions are
actually made and where the reviewer's only later input is the resulting code. When implementation
discovers a constraint the plan did not anticipate, the choice that follows is invisible: no
alternatives, no assumptions, no invariants, no stated uncertainty — just code that looks locally
reasonable.

Constraints this design must respect:

- **Rigor over latency** (golden rule 3): the gate may not weaken or bypass any existing review.
- **Default-inert**: repos that do not opt in must observe no behavioral change at all.
- **Determinism where determinism is possible**: triggering, blocking, recurrence, and resume are
  deterministic; only the challenge generation and the defense are model work.
- **Convergence**: the review layer's hard-won lesson is that unbounded re-review cascades. The gate
  must be bounded and recurrence-aware from day one, reusing the existing semantics rather than
  inventing parallel ones.
- **No hidden reasoning**: the artifact captures externally-checkable claims and citations, never
  chain-of-thought.

## Goals / Non-Goals

**Goals**
- Make material implementation-time design decisions explicit, challengeable, and durable.
- Trigger only on configured risk classes, deterministically, with a recorded reason.
- Block advancement on unresolved material challenges; keep advisory challenges as evidence.
- Converge: bounded rounds, recurrence-aware early park, `needs-human` off-ramp with a punch list.

**Non-Goals**
- Capturing private chain-of-thought or raw hidden model reasoning.
- Running a conversational review on every PR.
- Letting the reviewer expand product scope beyond the issue and approved plan.
- Any merge or release authority (the pipeline still stops at `ready-to-deploy`).
- Replacing plan review or standard/adversarial diff review.

## Decisions

### D1 — A real stage (`design-gate`) between `implementing` and `review-1`

**Chosen**: add `design-gate` to `STAGES` immediately after `implementing`, dispatched to its own
handler, and always traversed — advancing instantly with a recorded skip when disabled or untriggered.

*Alternatives rejected*: (a) a sub-step inside `implementing` — invisible in `--status`, not
resumable after a crash, and it would make the "did it run and why" record a side effect rather than
a stage record; (b) a sub-step inside `review-1` — conflates decision interrogation with diff review
and would inherit the diff-review round budget; (c) a conditionally-present stage label — the state
machine assumes a fixed ordered `STAGES` constant, and a variable graph would break stage-index
comparisons and `--status`.

The cost is one extra label transition on every run, including untriggered ones. That is accepted:
it is deterministic, cheap (no harness call), and it buys a uniform, inspectable "why not" record.

### D2 — Deterministic trigger evaluation, config-declared risk classes

`evaluateDesignGateTrigger(inputs) → { triggered, matched[], reason }` is pure: its inputs are the
changed-file paths (from the existing diff surface), the issue's labels, and the diff size. Each
built-in trigger class is a named set of path globs plus optional label names; a repo may enable a
subset, and may extend a class with additional globs. `architecture` additionally matches on a
changed-file-count / changed-line threshold.

*Alternatives rejected*: an LLM risk classifier (non-deterministic, unauditable, and it would make
"why did the gate run" a model opinion); always-on triggering (violates the issue's scope and the
default-inert constraint).

Trigger evaluation happens **after** `implementing` has produced commits, so the changed-file set is
real rather than predicted. The implementing prompt is told the gate is *armed* (which classes could
fire) so the implementer can record decisions as it goes rather than reconstructing them.

### D3 — Decision record as a schema-versioned JSON artifact, not prose

The implementer emits `design-decisions.json` (`schema_version: 1`) into the run directory and
embeds it as a hidden base64 artifact block in the gate's issue comment — the same dual-persistence
pattern as `ReviewArtifact`, which gives both machine parsing and crash-resume without a new store.

Bounds are enforced by the pipeline, not trusted from the model: at most `limits.max_decisions`
decisions, at most `limits.max_field_chars` per free-text field, and a hard byte ceiling on the
persisted artifact. Over-budget content is truncated with an explicit `…[truncated]` marker so the
evidence never silently loses content. Redaction reuses the existing secret-redaction helpers used
for `CommandRecord`/`PromptRecord`.

*Alternative rejected*: free-form markdown. It cannot be validated, bounded, diffed across rounds, or
keyed for recurrence.

### D4 — Reviewer is the configured independent harness; fallback is disclosed, not silent

The gate invokes `cfg.harnesses.reviewer` (i.e. `review_harness`, already the pipeline's
independence mechanism) with its configured model/effort. When that resolves to the same harness and
model as the implementer, the round still runs — a same-harness challenge is worth more than no
challenge — but the run records `reviewerIndependence: "same-harness-fallback"` and renders it in
both the comment and the bundle so the evidence never overstates independence.

*Alternative rejected*: hard-failing on same-harness. It would make the gate unusable on
single-harness installs, and silently downgrading is worse than disclosing.

### D5 — Challenge verdict schema mirrors the review verdict, single-sourced

`DESIGN_CHALLENGE_SCHEMA_BLOCK` lives next to `review-schema.ts` and is substituted into the
interrogation prompt via `{{schema_block}}`, drift-guarded by a test — exactly the existing pattern.
Verdict: `approve` with zero challenges, or `needs-attention` with **3–7** challenges, each carrying
`decision_id`, `title`, `severity`, `confidence`, `falsifier` (what evidence would settle it),
`evidence_request`, and `required_action` ∈ `defend | revise | accept-uncertainty`.

Parsing fails conservatively, as `parseStructuredVerdict` does: unparseable output becomes
`needs-attention` with the raw output attached, never an approval. One bounded re-ask is allowed for
a malformed response before the gate blocks — the re-ask is cheap and malformed JSON is the most
common transient failure.

### D6 — Stable challenge identity + reuse of the recurrence semantics

`challengeKey = sha1(severity | decision_id | normalize(title))` truncated to 8 hex, deliberately
parallel to `findingKey` (`stable-finding-identity`) including the same title normalization. This
gives, for free: dispositions that survive re-review, a recurrence trigger, and punch-list rendering
identical in shape to the review ceiling comment.

Loop: `design-gate` → (blocking challenges) → implementer response round → re-review, bounded by
`design_gate.max_rounds` (default 2). A blocking key that recurs after a response round parks at
`needs-human` immediately without consuming budget — the same early-park rule that fixed the review
layer's non-converging cascade. Exhaustion parks at `needs-human` with a punch list.

*Alternative rejected*: an unbounded "argue until resolved" conversation — the exact failure mode the
review layer already paid for.

### D7 — Blocking is policy-driven, matching `review_policy`

A challenge blocks iff `severity >= design_gate.block_threshold` **and**
`confidence >= design_gate.min_confidence`; otherwise it is advisory and recorded as evidence
without blocking. Defaults mirror the review policy (`block_threshold: "medium"`,
`min_confidence: 0.6`). A response round can move a challenge to `defended` (evidence accepted),
`revised` (decision record updated), or `uncertainty-accepted` (explicitly preserved, recorded, and —
because the uncertainty is now stated — no longer blocking). Reviewer keeps authority to re-block a
`defended` challenge only by emitting it again, which is exactly what the recurrence rule catches.

### D8 — Resume

Gate state (trigger record, decision record, per-round challenges and dispositions, round counter)
is written to the run directory and mirrored into the gate comment artifact. On re-entry the handler
rehydrates from the persisted state and only runs the round that has not completed — a crash never
re-invokes a completed reviewer round or discards accepted dispositions.

## Risks / Trade-offs

- **Cost/latency on high-risk changes** → the gate is opt-in, trigger-scoped, and bounded to
  `max_rounds` (default 2); untriggered runs make zero harness calls.
- **The reviewer expands scope beyond the issue/plan** → the prompt scopes challenges to the decision
  record and the approved plan, and requires a falsifier per challenge; out-of-scope challenges are
  dispositioned as deferred follow-ups per the repo's existing convention.
- **Decision-record theater (a record that says nothing)** → the schema requires alternatives with
  `rejected_because`, and a decision with no alternatives and no stated uncertainty is itself a valid
  challenge target; validation rejects empty required fields rather than accepting placeholders.
- **New non-converging loop** → mitigated by reusing the proven early-park + ceiling semantics
  wholesale rather than inventing new ones.
- **Evidence bloat** → per-field and per-artifact byte ceilings with explicit truncation markers.
- **Extra label transition on every run** → deterministic and harness-free; recorded as a skip.

## Migration

None. `design_gate.enabled` defaults to `false`; existing repos traverse `design-gate` as an
immediate no-op with a `gate-disabled` record and are otherwise unchanged.
