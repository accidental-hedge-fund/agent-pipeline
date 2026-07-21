## Why

The pipeline reviews the **plan** (plan-review) and the **diff** (review-1 / review-2), but
nothing reviews the material architectural decisions the implementer makes *while*
implementing. Implementation routinely surfaces constraints the plan never anticipated, and the
resulting choices — a lock granularity, a storage shape, an auth boundary, a migration ordering —
arrive at diff review as fait accompli: locally plausible, globally unexamined, and with the
rejected alternatives and load-bearing assumptions never written down.

Issue #436 closes that seam with a **risk-triggered design-interrogation gate**: for configured
risk classes only, the implementer must publish a bounded, machine-readable decision record, an
independent reviewer must challenge it with falsifiable challenges, and the implementer must
defend, revise, or explicitly preserve uncertainty before the diff is treated as reviewable
evidence. The product value is not another critic call — it is durable proof that consequential
design choices were surfaced, challenged, and resolved.

## What Changes

- **New `design-gate` stage** in `STAGES`, between `implementing` and `review-1`. It is a
  structural position in the graph, but it is **inert unless triggered**: when the gate is
  disabled or no risk trigger matches, it advances immediately with a recorded skip reason.
- **New `design_gate` config block** (`enabled` default `false`, risk `triggers`, `max_rounds`,
  `block_threshold`, `min_confidence`, artifact `limits`). Default-off means zero behavior change
  for existing repos and low-risk work.
- **Deterministic trigger evaluation** — a pure function over the changed-file set, issue labels,
  and diff size that returns a matched/not-matched decision plus the evidence for it. Built-in
  trigger classes: `concurrency`, `storage`, `auth`, `migration`, `infrastructure`, `public-api`,
  `architecture`. Every run records why the gate did or did not fire.
- **Decision record artifact** — a schema-versioned, size-bounded JSON document emitted by the
  implementer: decision, affected surface, alternatives considered and why rejected, assumptions,
  invariants, supporting repository/runtime evidence, generalization boundary, and uncertainty.
- **Independent interrogation round** — the configured reviewer harness receives the issue, the
  approved plan, relevant source context, and the decision record, and returns a validated
  structured verdict: `approve`, or 3–7 falsifiable challenges with stable challenge keys,
  severity, confidence, evidence request, and required next action. Same-harness fallback (when
  the reviewer resolves to the implementer harness) is executed but explicitly disclosed.
- **Bounded, recurrence-aware response loop** — the implementer defends with evidence, revises the
  decision, or accepts uncertainty explicitly. Unresolved **blocking** challenges prevent
  advancement; advisory challenges are recorded as evidence. A challenge key that recurs after a
  response round, or exhaustion of `max_rounds`, routes to `needs-human` with a concrete punch
  list — mirroring the existing review-loop recurrence semantics.
- **Durable evidence** — the proposed record, challenges, responses, revisions, reviewer identity
  (harness/model/effort + fallback disclosure), and final verdict are written to the evidence
  bundle and rendered in the human-readable summary, redacted and size-capped, with **no hidden
  model reasoning** captured.

Not changed: the four `steps` toggles, plan review, standard/adversarial diff review, and the
never-auto-merge guarantee. The gate adds coverage; it replaces nothing.

## Capabilities

### New Capabilities
- `design-interrogation-gate`: the `design-gate` stage — configuration, deterministic risk
  triggering, independent reviewer invocation and identity disclosure, structured challenge
  verdict, blocking vs advisory disposition, bounded recurrence-aware response loop, and the
  `needs-human` off-ramp.
- `design-decision-record`: the schema-versioned, size-bounded decision artifact the implementer
  emits and revises — its fields, validation, truncation, redaction, and persistence/resume
  semantics.

### Modified Capabilities
- `pipeline-state-machine`: `STAGES` gains `design-gate` between `implementing` and `review-1`,
  and dispatch routes it to the design-gate handler.
- `evidence-bundle`: the bundle gains a `designInterrogation` record carrying the full
  decision → challenge → response → verdict chain.

## Impact

- `core/scripts/types.ts` — `STAGES`, `MODEL_INVOKING_STAGES`, `PipelineConfig.design_gate`,
  decision-record and challenge-verdict types.
- `core/scripts/config.ts` — `design_gate` schema + defaults.
- `core/scripts/stages/design_gate.ts` (new) + trigger/verdict-parsing helpers; dispatch wiring in
  `core/scripts/pipeline.ts`.
- `core/scripts/prompts/design_decision_record.md` and `design_interrogation.md` (new), plus an
  `implementing.md` addendum that is injected only when the gate is armed.
- `core/scripts/evidence-bundle.ts`, `run-store.ts` (resume state), `status-json.ts` (surface).
- `core/test/` — new tests; `plugin/` mirror regenerated via `node scripts/build.mjs`.
- Repos that do not set `design_gate.enabled` observe no change in behavior, timing, or output.

## Acceptance Criteria

- [ ] With no `design_gate` block in `.github/pipeline.yml`, an end-to-end run's stage sequence,
      comments, and evidence bundle are byte-identical to pre-change behavior apart from the
      `design-gate` pass-through record.
- [ ] `.github/pipeline.yml` can enable the gate and select/extend its risk triggers; an unknown
      `design_gate` key is rejected at config-parse time (strict schema).
- [ ] Trigger evaluation is a pure function (no network/git/subprocess) that returns the same
      result for the same inputs and always yields a machine-readable reason — matched trigger ids
      with their matching evidence, or the specific not-matched reason (`gate-disabled`,
      `no-trigger-matched`).
- [ ] A triggered run produces a decision artifact with `schema_version`, and per decision:
      `id`, `title`, `surface`, `alternatives[] {option, rejected_because}`, `assumptions[]`,
      `invariants[]`, `evidence[]`, `generalization_boundary`, and `uncertainty`.
- [ ] The artifact is size-bounded: decisions beyond the configured count and fields beyond the
      configured character budget are truncated with an explicit truncation marker, never silently
      dropped, and the persisted artifact never exceeds the configured byte ceiling.
- [ ] The gate invokes `cfg.harnesses.reviewer`; when that resolves to the same harness (and model)
      as the implementer, the run still executes but records and renders an explicit
      `same-harness fallback` disclosure in the comment and evidence bundle.
- [ ] Reviewer output is parsed into a validated verdict; a malformed or unparseable response never
      counts as approval — it yields `needs-attention`, exactly one bounded re-ask, then blocks.
- [ ] Each challenge carries a stable `challengeKey` that is identical across rounds when the
      decision id, severity, and normalized title are unchanged, and different when any of them
      changes.
- [ ] A challenge blocks when its severity meets `block_threshold` **and** its confidence meets
      `min_confidence`; otherwise it is advisory, recorded as evidence, and does not block.
- [ ] At least one unresolved blocking challenge prevents the transition to `review-1`; the issue
      stays at `design-gate` (or parks) and no diff review is invoked.
- [ ] A challenge disposed as `defended` or `revised` in an earlier round retains that disposition
      across re-review and is not re-litigated from scratch.
- [ ] A blocking `challengeKey` that recurs after a response round parks at `needs-human` without
      consuming further round budget; exhausting `max_rounds` also parks at `needs-human`, and both
      post a punch list naming each unresolved challenge and its required next action.
- [ ] When the reviewer harness is unavailable, the gate blocks with a specific blocker rather than
      advancing or silently skipping.
- [ ] A crash mid-gate is resumable: on re-entry the pipeline reuses the persisted decision record,
      challenges, and dispositions instead of re-invoking a completed round.
- [ ] The evidence bundle and the human-readable summary contain the full
      decision → challenge → response → revision → verdict chain with reviewer identity, redacted
      by the existing secret-redaction rules, and contain no raw hidden model reasoning.
- [ ] Tests cover: no-trigger, clean approval, defense accepted, revision required, recurring
      unresolved challenge, malformed reviewer output, unavailable reviewer, crash/resume, and
      redaction/size limits.
