## 1. Correction cluster accumulator

- [x] 1.1 Add `ClusterCategory` member `"correction"` in `core/scripts/improve.ts` and extend
      the `ClusterEntry`/`ClusterAccum` shapes with the correction evidence bundle
      (distinct-run set, distinct-item set, first/last seen, affected stages, affected
      harnesses/actors, severity/impact when available, and the seen-`correction_id` set for
      dedup).
- [x] 1.2 Add `clusterCorrections(event, runId, clusters, ...)` that reads `correction_event`
      records line-by-line, keys clusters on `correction:${correction_key}` (from the event
      contract — never `normalizeSignal`), and collapses duplicate deliveries by `correction_id`
      so one id counts once. Use `normalizeSignal(correction)` only for the human-readable label
      and excerpt.
- [x] 1.3 Ensure category isolation: correction clusters never merge with `papercut`,
      `review-finding`, `blocker`, `flaky-gate`, or `token-waste`, even when signals coincide
      (same `(category, key)` isolation rule already used).

## 2. Occurrence semantics and thresholds

- [x] 2.1 Count occurrences as distinct `correction_id`s within a `correction_key` cluster; also
      compute distinct run count and distinct item (issue/PR) count for the report.
- [x] 2.2 Set the `correction` category `--min-occurrences` default to 2 (singletons visible in
      report/`--json`, never filed at default); keep other categories' default unchanged.

## 3. Control-level proposal + graduation ladder

- [x] 3.1 Add a `proposeControlLevel(cluster)` helper that returns one of `instruction`,
      `skill-rubric`, `eval`, `deterministic-gate`, `human-judgment`, or `undetermined`,
      seeded deterministically from the cluster's consistent `proposed_control` and informed by
      `failure_class`; falls back to `undetermined` when absent/mixed.
- [x] 3.2 Enforce the graduation ladder `documented rule -> skill/rubric -> eval ->
      deterministic gate`: propose the lowest rung the evidence supports; taste/strategy/product-
      judgment/authority classes resolve to `human-judgment`/`undetermined` and are never
      hardened into `eval`/`deterministic-gate`.
- [x] 3.3 Render the proposal block into the issue body: the named control level (or
      `undetermined`), acceptance criteria, and a rationale tying the level to the evidence.
      Any LLM enrichment is advisory/draft only and clearly marked as not human-approved.

## 4. Authority boundary — LLM cannot decide identity/qualification

- [x] 4.1 Keep cluster identity, dedup, and qualification a pure function of bounded fields;
      route any enrichment LLM through an injectable dep that is a no-op by default in tests, and
      assert membership/qualification are identical with it stubbed out.

## 5. Report / JSON / apply threading

- [x] 5.1 Thread `correction` through the human-readable report and `--json` output, emitting the
      evidence bundle fields (count, distinct runs/items, first/last seen, stages, harnesses,
      severity/impact, sanitized excerpts) and the control-level proposal.
- [x] 5.2 `--apply` for correction clusters reuses the existing open-issue `[pipeline-improve]`
      dedup and `proposedTitle`, creates only `pipeline:backlog` issues, and never queues,
      advances, approves, or merges. Confirm sanitization (secret redaction + injection screen)
      on every excerpt/body line.

## 6. Opt-in correction auto-file (reuse papercut path)

- [x] 6.1 Add an opt-in `corrections` config block in `config.ts` mirroring the `papercuts`
      auto-file keys (`auto_file`, `auto_file_window_hours`, `auto_file_max_per_window`,
      `auto_file_min_occurrences` floor 2), off/inert by default.
- [x] 6.2 Add a correction auto-file entry that reuses the papercut cluster→issue create
      machinery (min-occurrence, open-issue dedup, per-window rate cap, sanitization, provenance,
      non-fatal totality) keyed on correction clusters.
- [x] 6.3 Document the single-host concurrency scope (#459) on the correction auto-file path in
      runtime/docs; do not claim cross-host global deduplication for it.

## 7. Tests + mirror + CI

- [x] 7.1 Fixtures + tests: identical-key recurrence, semantically-different keys (no merge),
      singleton (visible not filed), duplicate-delivery (one `correction_id` counts once),
      secret-bearing (redacted in report + body), and human-judgment (never a gate).
- [x] 7.2 Category-isolation test (correction vs papercut/flaky-gate/token-waste with coinciding
      signals) and control-level/graduation-ladder assertions; prove each test bites without the
      change.
- [x] 7.3 `node scripts/build.mjs` to regenerate the `plugin/` mirror; run `npm run ci` from
      root until green (`ci:core`, mirror check, install smoke, `openspec validate --all`).
