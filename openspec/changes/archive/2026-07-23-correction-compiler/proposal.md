## Why

Issue #499 gave the pipeline a first-class, append-only `correction_event` ledger: every
*observable* accepted operator correction or recovered failure now records a stable
`correction_id`, a deterministic `correction_key` (derived from `source_kind` +
`failure_class` + `stage` only), an evidence-lineage pointer, and an optional
`proposed_control`. But nothing yet *reads* that ledger. Recurring expert corrections — the
same class of failure being hand-fixed run after run — still silently consume expert attention,
because the recurrence is only latent in the event stream.

`pipeline improve` already clusters five telemetry/agent-reported categories
(`review-finding`, `blocker`, `flaky-gate`, `token-waste`, `papercut`) into backlog candidates.
This change adds the **control compiler**: a distinct `correction` category that
deterministically clusters recurring `correction_event` records by their stable
`correction_key` and turns qualifying clusters into approval-gated, triage-ready
**reusable-control proposals**. A repeated correction class becomes one evidence-backed backlog
candidate that names the next control level — an instruction, a skill/rubric, a golden-task
eval, a deterministic validator/gate, or an explicit human-judgment boundary — so a known
failure stops being rediscovered by hand.

The compiler is deterministic and authority-bounded. Cluster identity, deduplication, and
qualification are decided by the bounded event contract, never by raw-text similarity or a
model. An LLM may only enrich a draft's prose. Dry-run stays the default; `--apply` creates
only `pipeline:backlog` issues and never queues, advances, approves, or merges them; and any
optional auto-file path reuses the exact minimum-occurrence, deduplication, rate-cap,
sanitization, and audit controls already shipped for papercuts (#421), constrained to the
single-host concurrency scope of #459.

## What Changes

- Add a sixth `improve` category, `correction`, sourced from `correction_event` records read
  from run artifacts. Correction clusters are keyed on the deterministic `correction_key` from
  the event contract (never `normalizeSignal` free-text), stay category-isolated, and never
  merge with `papercut`, `review-finding`, `blocker`, `flaky-gate`, or `token-waste` clusters.
- Make clustering identity, dedup, and qualification a pure function of bounded event fields.
  Raw-text similarity or an LLM MAY enrich a proposal draft but SHALL NOT determine cluster
  identity, deduplication, or whether a cluster qualifies.
- Report, per correction cluster, the occurrence count, distinct runs and distinct items
  (issues/PRs), first/last seen timestamps, affected stages and harnesses/actors,
  severity/impact evidence when available, and sanitized evidence links/excerpts.
- Count a cluster's occurrences by **distinct correction instance**: repeated delivery/replay of
  one `correction_id` counts once (reusing the ledger's `correction_id` idempotency). Issue
  creation requires **two distinct correction occurrences** by default (`--min-occurrences`
  default 2 for this category); singletons remain visible in dry-run/JSON output but are never
  filed.
- Attach to every proposed issue a **next control level** — one of `instruction`,
  `skill-rubric`, `eval`, `deterministic-gate`, `human-judgment`, or the explicit sentinel
  `undetermined` — plus acceptance criteria and a short rationale explaining why that level fits
  the evidence. The proposal SHALL follow the graduation ladder
  `documented rule -> skill/rubric -> eval -> deterministic gate` and SHALL NOT harden
  provisional taste, strategy, product judgment, or authority into an executable gate.
- Keep dry-run the default. `--apply` reuses the existing open-issue `[pipeline-improve]` dedup
  and creates only `pipeline:backlog` issues; it never queues, advances, approves, or merges
  them.
- Add an **optional, off-by-default** correction auto-file path that reuses the papercut
  auto-file machinery — minimum-occurrence, open-issue dedup, per-window rate cap, sanitization,
  and audit/provenance — with correction-specific occurrence semantics. Multi-host auto-filing
  honors #459: until cross-host serialization exists, the runtime and docs enforce the supported
  single-host constraint rather than claiming global deduplication.

## Capabilities

### New Capabilities

- `correction-compiler`: The `correction` clustering category and control-proposal engine — its
  deterministic `correction_key`-based cluster identity and bounded-field authority (LLM may
  enrich but not decide), the distinct-instance occurrence counting with duplicate-delivery
  collapsed by `correction_id`, the singleton-visible / two-occurrence-to-file default, the
  per-cluster evidence bundle, the next-control-level proposal (one of the five levels or
  `undetermined`) with acceptance criteria and rationale, the graduation-ladder guardrail, and
  the dry-run-default / `--apply`-files-only-`pipeline:backlog` authority boundary.
- `correction-auto-file`: The opt-in, off-by-default auto-file path for recurring correction
  clusters — reusing the papercut minimum-occurrence, open-issue dedup, per-window rate cap,
  sanitization, provenance, and non-fatal controls, and honoring the single-host concurrency
  scope of #459.

### Modified Capabilities

- `improve-command`: Add `correction` as the sixth recognized category, keyed on the
  deterministic `correction_key` rather than `normalizeSignal`, kept category-isolated from the
  other five, surfaced in the report / `--json` / `--apply` paths like any other category.

## Impact

- `core/scripts/improve.ts` — a `clusterCorrections` accumulator that reads `correction_event`
  records (streamed line-by-line like the others), keys clusters on `correction_key`, collapses
  duplicate `correction_id` deliveries, and carries the correction evidence bundle; a
  `correction`-aware proposal renderer that names the next control level, acceptance criteria,
  and rationale; the `correction` category threaded through the report, `--json`, `--apply`,
  dedup, and per-category min-occurrences default.
- `core/scripts/stages/papercut.ts` (auto-file path) — a correction auto-file entry that reuses
  the papercut cluster→issue create machinery (dedup, rate cap, sanitization, provenance,
  non-fatal), keyed on correction clusters.
- `core/scripts/config.ts` — an opt-in `corrections` auto-file config block mirroring the
  `papercuts` auto-file keys (off by default); single-host constraint documented on it.
- `core/test/` — replay/idempotent-`correction_id`, semantically-different-key, singleton,
  duplicate-delivery, secret-bearing, and human-judgment fixtures; category-isolation and
  control-level / graduation-ladder assertions.
- `plugin/` mirror regenerated. No state-machine edge, review verdict, blocking, or routing
  decision reads correction clusters — the compiler only reads the ledger and, at most, files a
  `pipeline:backlog` issue.

## Acceptance Criteria

Observable, falsifiable outcomes that make #500 done:

- [ ] `pipeline improve` reads `correction_event` records and reports a separate `correction`
      category; a test proves a correction cluster never merges with a `papercut`,
      `review-finding`, `blocker`, `flaky-gate`, or `token-waste` cluster even when their
      signals coincide.
- [ ] Correction cluster identity is the deterministic `correction_key` from the event
      contract: two events with the same `correction_key` cluster together, two with different
      keys do not, and no raw-text similarity or LLM call changes cluster membership,
      deduplication, or whether a cluster qualifies (a test asserts identity is unchanged with
      the enrichment LLM stubbed out / absent).
- [ ] Repeated delivery/replay of one `correction_id` counts as a single occurrence; two
      distinct `correction_id`s in the same `correction_key` cluster count as two.
- [ ] A singleton correction cluster appears in the dry-run report and `--json` output but is
      never filed at the default threshold; issue creation requires two distinct occurrences.
- [ ] Each reported correction cluster carries occurrence count, distinct run count, distinct
      item (issue/PR) count, first/last seen, affected stages and harnesses/actors,
      severity/impact evidence when available, and sanitized evidence links/excerpts.
- [ ] Every proposed correction issue names exactly one next control level (`instruction`,
      `skill-rubric`, `eval`, `deterministic-gate`, `human-judgment`) or the explicit
      `undetermined`, and includes acceptance criteria plus a rationale tying the level to the
      evidence.
- [ ] The proposal follows the graduation ladder `documented rule -> skill/rubric -> eval ->
      deterministic gate`; a human-judgment fixture yields a `human-judgment` (or `undetermined`)
      proposal and is never hardened into an `eval` or `deterministic-gate` (a test asserts
      taste/strategy/judgment corrections do not propose an executable gate).
- [ ] Dry-run is the default (no issue creation, no state mutation). `--apply` creates only
      `pipeline:backlog` issues, reuses the existing open-issue `[pipeline-improve]` dedup, and
      never queues, advances, approves, or merges any issue.
- [ ] Correction auto-file is off by default and inert when unconfigured; when enabled it reuses
      the papercut minimum-occurrence, open-issue dedup, per-window rate cap, sanitization, and
      provenance/audit controls, and never fails a run, stage, or batch.
- [ ] Multi-host correction auto-filing honors #459: the runtime and docs state the supported
      single-host constraint and do not claim cross-host global deduplication for this path.
- [ ] A secret-bearing correction fixture never leaks a raw secret into any report line or
      issue body (redacted form only); tests replay identical, semantically-different, singleton,
      duplicate-delivery, secret-bearing, and human-judgment correction fixtures; `npm run ci`
      is green and the `plugin/` mirror is regenerated and committed.
