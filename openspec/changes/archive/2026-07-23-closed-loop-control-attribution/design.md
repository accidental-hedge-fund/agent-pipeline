## Context

The correction ledger (#499) records *what* expert correction changed a run, keyed for
recurrence by a deterministic `correction_key` (`source_kind` + `failure_class` + `stage`) and
for idempotency by `correction_id`. The compiler (#500) reads that ledger and files
reusable-control proposals that name a next control level. What is still missing is the **outcome
half of the loop**: a durable link from a `correction_key` to the control that resolved it, and a
measurement of recurrence before vs. after that control became effective.

Two reuse surfaces already exist and constrain the design:

- `pipeline correction record` (`core/scripts/correction.ts`, #499) is a narrow, authority-bounded
  command whose only side effect is one appended, sanitized `correction_event`. It never touches
  GitHub. The attribution write reuses this exact shape.
- `pipeline scoreboard` (`core/scripts/scoreboard.ts`, `factory-scoreboard`) is a read-only
  scanner of `.agent-pipeline/runs/*/` with an established window model, a zero-denominator→`null`
  rule, human/`--json`/`--html` output, `--bucket` day/week series, and a `--by` execution-identity
  grouping validated before any artifact is read. The recurrence metrics are additive report
  sections computed by the same scan.

## Decision 1 — attribution is an explicit, audited record, never an inferred side effect

The acceptance criteria are emphatic: closing an issue or merging an arbitrary PR must not
silently mark a control effective. So attribution is written **only** by an explicit command,
`pipeline correction attribute`, a sibling of `pipeline correction record`. It carries the same
authority boundary — `mutatesGitHub: false`, `needsGhAuth: false` — and appends exactly one
sanitized `control_attribution` record. No state-machine edge, no `pre_merge`/`deploy_ready`
handler, and no `pipeline merge` path writes an attribution. This keeps the human (or an audited
tool) in the loop about *which* control resolved *which* correction class, which is the whole
point: an attribution is a claim a maintainer stands behind, not a heuristic guess.

Rejected alternative — inferring attribution from a merged PR that references the proposal issue.
That would reintroduce exactly the silent-effectiveness failure the issue forbids, and a
PR→issue→correction_key chain is not reliably present.

## Decision 2 — the `control_attribution` record shape

```
{
  schema_version: 1,
  type: "control_attribution",
  at: "<ISO append time>",
  attribution_id: "<stable idempotent id>",
  correction_key: "<the #499 key this control targets>",
  control_type: "instruction" | "skill-rubric" | "eval" | "deterministic-gate" | "human-judgment",
  disposition: "implemented" | "human-owned" | "rejected" | "superseded",
  issue: <int | null>,       // the control-proposal issue
  pr: <int | null>,          // the PR that shipped the control
  effective_commit: "<sha> | null",
  effective_release: "<tag/version> | null",
  effective_at: "<ISO> | null", // when the control became effective; null unless implemented
  supersedes: "<attribution_id> | null",
  evidence_ref: { kind: "finding"|"blocker"|"event"|"comment"|"artifact", id: "<string>" },
  note: "<bounded, sanitized free text>"
}
```

`control_type` reuses `CORRECTION_PROPOSED_CONTROLS` from #499 verbatim (single source of truth,
drift-guarded by test) so the ladder vocabulary stays consistent. `attribution_id` is derived by
a pure `deriveAttributionId({ correction_key, control_type, issue, pr, effective_commit,
effective_release, disposition })` hash so re-recording the same attribution (crash-retry, replay)
is idempotent and a consumer deduping by `attribution_id` collapses it. The `note` and
`evidence_ref.id` free text pass the existing injection denylist + secret redaction before
serialization; the write is non-fatal (caught, warned, never aborts).

`effective_at` is the recurrence boundary and is set **only** for `disposition: "implemented"`
(and for a `superseded` record that itself carries a new effective control). `human-owned` and
`rejected` record an audited disposition but set no boundary — a human-judgment correction is not
expected to be stopped by a gate, so it is never scored as a failed control.

## Decision 3 — where attributions are stored

Attributions are factory-level facts, not run-scoped, so they live in a durable append-only
ledger `.agent-pipeline/control-attributions.jsonl` under the repository root (beside
`.agent-pipeline/runs/`). The scoreboard reads it once per invocation alongside its run scan. A
missing ledger is a valid empty state (no attributions), not an error. This avoids overloading a
single run directory with a cross-run fact and keeps the writer a single append.

## Decision 4 — recurrence metrics reuse the correction ledger already on disk

The scoreboard already scans every included run's `events.jsonl`. `correction_event` records are
in that same stream, so the recurrence aggregator reads them during the existing scan — no new
instrumentation. Corrections are deduped by `correction_id` (a replayed correction counts once),
classes are `correction_key`s, a "repeated class" has ≥2 distinct `correction_id`s, and
"corrections per ready-to-deploy item" divides distinct corrections by the successful-PR
denominator the scoreboard already computes. All ratios follow the existing zero-denominator→`null`
rule.

## Decision 5 — post-control recurrence over *eligible* exposure, three-way classification

For each `correction_key` with an `implemented` attribution, the boundary is the attribution's
`effective_at`. **Eligible post-control exposure** = included runs whose resolved start timestamp
(the same timestamp the scanner already uses for window filtering) is strictly after
`effective_at` **and** that exercised the class's `stage` — evidenced by a `stage_start`/
`stage_complete` for that stage (for a null-stage class, any included run after the boundary
qualifies). Then:

- `recurred` — at least one eligible post-control run emitted a `correction_event` with that
  `correction_key`. The report lists the recurring evidence pointers.
- `no_recurrence_observed` — ≥1 eligible post-control run, none of which recurred.
- `insufficient_post_control_evidence` — **zero** eligible post-control runs. The report never
  reports this as `no_recurrence_observed`; absence of exposure is not evidence of a fix.

`time-to-control` is `effective_at − first-seen correction timestamp` for the class, reported per
attributed class and as a distribution. Because a documentation-only control (`instruction`)
still sets an `effective_at`, a class that keeps recurring after it is correctly scored
`recurred` — which is exactly how the fixtures prove a doc-only control is not mistaken for a fix.

## Decision 6 — supersession, rollback, and non-causal framing

When attribution B carries `supersedes: A`, the class's active boundary is the latest
non-`rejected` implemented attribution; the report shows the full supersession chain rather than
hiding A. A **rollback** is represented as a later attribution that either supersedes the prior
`implemented` one with a `rejected`/`human-owned` disposition or ships a replacement control;
either way recurrence is re-measured from the new boundary and the prior control is shown as
superseded/rolled-back. The report never states a control *caused* a recurrence change — it
reports temporal attribution (control effective at T) and recurrence evidence (occurrences before
and after T over eligible exposure), leaving causal judgment to the maintainer.

## Decision 7 — grouping and trends reuse existing scoreboard machinery

`--corrections-by <dimension>` mirrors the `--by` validation exactly: exactly one dimension,
rejected-before-any-read on an unsupported or repeated value, additive JSON key, additive human
section. Supported dimensions are `repo`, `stage`, `harness`, `model`, `source_kind`,
`failure_class`, `proposed_control`, and `implemented_control` — the correction/attribution
dimensions the ACs name (distinct from `--by`'s execution-identity dimensions, which stay for
accounting). Rolling-window trends reuse the existing `--bucket` day/week series: each period
additionally carries its own recurrence totals. The top-still-recurring-classes list ranks classes
by post-control (or in-window, when unattributed) recurrence with sanitized evidence pointers.

## Decision 8 — read-only and tolerant, consistent with the capability

The recurrence sections change nothing: no GitHub call, no write under `.agent-pipeline/`, and no
write to the attribution ledger (the scoreboard only reads it). Malformed/partial/old-schema
`correction_event` or `control_attribution` records, and attributions referencing an unknown
`correction_key`, are surfaced as window-level diagnostics with stable reason codes
(`corrupt_correction_event`, `corrupt_attribution`, `unknown_schema_version`,
`orphan_attribution`) and never crash the scan or skew a metric silently.
