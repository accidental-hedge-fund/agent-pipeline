## Context

Factory scoreboard (#425/#437/#683) already aggregates throughput, cost, pre-merge needs-human by class, and related rates from `.agent-pipeline/runs/*/`. Auto-file paths (papercut, correction, durable-run-blocker) stamp **category provenance** HTML markers for cross-host rate-cap reconciliation, but not **which engine version+SHA** produced the filing. `run.json` pins `engine.version`, `engine.root`, and `templates_fingerprint` but not git SHA. Discovery of issues cannot be split into live-run vs review-batch vs auto-file vs manual, so batch-review filings look like organic regressions. Escape-recurrence and human-touch counts are untracked. Post-#787, terminal off-ramps must come from canonical stage diagnostics and recovery attempt/result events, not label/prose inference. #757 owns FRG composition and trend ledger; this change **consumes** those observations. #857 owns candidate-integrity control plane and durable events; this change **reports** them.

## Goals / Non-Goals

**Goals:**

- Stamp engine version + commit SHA + discovery-channel on auto-filed issues, blocker comments, and relevant run-ledger events (or inherit with a documented rule).
- Make stabilization metrics offline-computable from ledgers (+ optional read-only GitHub of already-authored markers) with explicit denominators and missing-evidence accounting.
- Report escape-recurrence, human-touches, discovery-channel mix, release-over-release engine-class needs-human, stratified rates from the recommendation upsert, and candidate-integrity observability.
- Keep scoreboard read-only and additive; preserve existing metric definitions unless extended by explicit ADDED requirements.

**Non-Goals:**

- HTML dashboards (#427) or new visual export requirements beyond existing scoreboard surfaces.
- Gates, thresholds, auto-merge, or FRG K / max engine-class rate changes that consume these numbers.
- Inferring human labor minutes from wall-clock spans; using raw events/day as a model comparison.
- Re-implementing FRG scoring, representative pack composition, or candidate-integrity enforcement.
- Requiring operators to hand-classify discovery channel or defect class for metrics to work.

## Decisions

### D1 — Closed discovery-channel vocabulary (coarse)

**Decision:** Discovery channel is exactly four values:

| Channel | Meaning |
| --- | --- |
| `live-run` | Observed during a normal issue advance / durable-loop item execution |
| `review-batch` | Observed or filed from a scheduled/batch review surface (not organic live-run) |
| `papercut-autofile` | Filed by any engine auto-file category (papercut, correction, durable-run-blocker) |
| `manual` | Human-authored issue or human-initiated intake without auto-file provenance |

**Rationale:** Issue text names these four; coarse channel separates organic failure from detector/batch filings. Fine-grained auto-file **category** remains the existing HTML provenance markers (`<!-- pipeline:papercut-auto-filed -->`, etc.) for rate-cap reconciliation (#631).

**Alternatives:** Separate channel per auto-file category — rejected for scoreboard decomposition (over-split); keep category markers as secondary breakdown when needed.

### D2 — Engine identity: version + commit SHA, additive markers

**Decision:**

1. Extend resolvable engine identity with `commit_sha` (full or documented length) when the engine root is a git checkout; when unresolvable, omit or set null and emit missing-identity diagnostic — never invent a SHA.
2. On GitHub-facing surfaces (auto-file bodies, blocker comments), add stable HTML comment markers, e.g.:
   - `<!-- pipeline:engine version=<semver> sha=<sha|unknown> -->`
   - `<!-- pipeline:discovery-channel <channel> -->`
   without removing existing category provenance markers.
3. On run events, prefer additive JSON fields `engine_version`, `engine_commit_sha`, `discovery_channel` on events that create/classify defects, interventions, recovery results, and auto-file outcomes. Events that omit fields MAY inherit from `run.json.engine` + run-level channel default (`live-run` for ordinary advance) — inheritance rule pinned by tests.

**Rationale:** Matches existing marker style; offline GitHub scans and ledger scans share the same strings; avoids schema_version bump if fields remain additive and optional for historical events.

**Alternatives:** Only stamp run.json and never GitHub — rejected (stale-install phantom P0 needs GitHub-visible attribution). Only parse package version without SHA — rejected (#176 class).

### D3 — Human-touch accounting is event-count based

**Decision:** Count discrete touch kinds from durable records:

- `override` (`--override` / human-risk-override intervention)
- `unblock` (unblock command / blocker_cleared after human action when typed)
- `merge` (session-bound merge / merge-queue apply when recorded)
- `hand_tag` (human-applied pipeline stage label when distinguishable from engine label writes)
- `manual_worktree_remove` (operator-driven worktree remove when recorded)

Aggregates:

- **per attempted issue:** touches / distinct issues that entered the pipeline window
- **per R2D issue:** touches / distinct issues that reached ready-to-deploy

Never convert timestamps to labor minutes. Missing kind evidence → count 0 for that kind and raise `missing_human_touch_evidence` diagnostic when the surface that should have emitted is known absent, not when simply zero.

**Rationale:** Issue forbids labor-minute inference; intervention events already exist for several kinds.

### D4 — Escape-recurrence uses fix-release boundary + class registry

**Decision:**

- Maintain a small **seed defect-class key** registry: at least `delta-sha-gate`, `openspec-archive`, `salvage`, `worktree` (exact strings locked by tests; aliases may map into them).
- A class becomes **fixed** when a control attribution (or documented release observation) records an `effective_release` / effective tag for that class, or when a release tag ships an issue known to fix that class via existing attribution records.
- **Recurrence** = at least one new occurrence of the same class key with timestamp/release **strictly after** the fix boundary.
- Scoreboard reports: classes_with_fix_boundary (denom), classes_with_post_fix_occurrence (num), ratio; plus per-key rows. Classes without a fix boundary contribute to missing-boundary diagnostics, not to the recurrence ratio denominator.

**Rationale:** Distinguishes “building fickleness in” from burn-in; uses #501 control-attribution when present; seed keys from the 2026-07-31 audit chains.

**Alternatives:** Require human to mark every fix — rejected (no new required human input). Recur on any same-title issue — rejected (unstable).

### D5 — Release-over-release trends consume FRG ledger

**Decision:** When `.agent-pipeline/frg/` (or the #757 trend-ledger path) has entries for release versions, scoreboard release series for engine-class needs-human / engine-class rate **reads those observations** for version keys and rates. When absent, fall back to release tags × run windows using the same engine-class classification rules already used by scoreboard/FRG scoreboard fields — document fallback as lower fidelity and emit a diagnostic. Do **not** re-run pack composition validation or invent a second `engine_class_rate` formula.

### D6 — Stratified metrics: explicit denominators table

**Decision:** Every new rate is a `RateValue` (`numerator`, `denominator`, `ratio | null`) with a named denominator:

| Metric | Numerator (sketch) | Denominator (sketch) |
| --- | --- | --- |
| Intervention-free first-attempt R2D | Issues R2D with zero human_intervention and single attempt path | Issues that reached R2D |
| Eventual R2D within bounded attempts | Issues R2D with attempts ≤ bound | Issues attempted in window |
| False product-judgment rate | Engine-owned recoverable class projected as product/human_authority | Projections of product/human_authority (or stage attempts with that projection) |
| Engine blockers per 100 stage attempts | 100 × engine-class blocker events | Stage attempts |
| Recovery success/exhaustion | Terminal success / exhaustion counts by reason | Recovery attempts by reason |
| Human touches / attempted | Touch count | Attempted issues |
| Human touches / R2D | Touch count on R2D issues | R2D issues |
| First-pass approval | Reviews approved first pass | Review entries |
| Fix rounds / recurring findings | Counts from existing review/fix artifacts | Same families as today |
| Final green/current/mergeable R2D | R2D with green CI + current + mergeable when evidence present | R2D issues with evidence present; missing evidence separate |
| Orphan followers / progress gaps / stale worktrees / false capacity waits | Counts from durable diagnostics | Attempted issues or capacity admission events as specified in specs |
| Evidence coverage | Records with required attribution fields present | Records in scope |

Risk/change-class stratification is optional secondary group-by when durable risk/class fields exist; omit rather than invent.

### D7 — Candidate-integrity metrics are pure consumers

**Decision:** Scoreboard reads #857 durable candidate-integrity events (mutation method, before/after SHA, classification, invalidation reason, path class). Metrics by mutation method and engine/version when present. No new enforcement, no promotion thresholds. Absent events → zeros + `missing_candidate_integrity_events` diagnostic for windows that claim to measure them.

### D8 — Classification sources (post-#787 honesty)

**Decision:** Prefer, in order: typed stage diagnostic fields; recovery attempt/result ledger fields; `offramp_class` / `blocker_kind` on durable events; engine-class projection helpers already shipped. **Do not** parse issue label sets or free-text comments as primary class sources. Historical events without new fields remain countable under residual/`other` / missing-evidence rules.

### D9 — Implementation seams and tests

**Decision:** Pure helpers for marker format, discovery-channel assignment, escape-recurrence boundary, and RateValue construction. Scoreboard collectors take injected deps (filesystem + optional gh fakes). No real network/git in unit tests. After `core/` edits: `node scripts/build.mjs` and commit `plugin/`.

## Risks / Trade-offs

- **[Historical runs lack stamps]** → Metrics use inheritance + residual buckets + explicit missingness; never fail closed on old artifacts.
- **[Hand-tag detection hard on GitHub alone]** → Count only when durable ledger records the touch; diagnose missing rather than scrape all timeline events by default.
- **[Escape-recurrence undercounts without attributions]** → Seed keys + missing-boundary diagnostics; ratio denom is classes with a known fix boundary only.
- **[FRG ledger path not yet present on every clone]** → Documented fallback + diagnostic; no hard dependency on #757 merge for scoreboard to run.
- **[Event schema growth]** → Additive optional fields; keep `schema_version: 1` unless an existing contract forces a bump.
- **[Metric sprawl]** → Group under scoreboard sections; each RateValue must name denom in JSON so operators can distrust zero-like ratios.

## Migration Plan

1. Land stamps on new auto-files, comments, and events (additive).
2. Land scoreboard collectors tolerant of missing fields.
3. Backfill not required; operators re-run scoreboard over windows that include new runs.
4. Rollback: omit new collectors (metrics disappear); markers left on GitHub are inert comments.

## Open Questions

- Exact HTML comment grammar for engine marker (single comment vs two) — lock in implementation tests; either is fine if parseable.
- Whether `review-batch` is assigned only when a batch/queue command context is active, or also when auto-file evidence cites a batch id — default: command/context that created the artifact.
- Bound N for “eventual R2D within bounded attempts” — default to existing auto-loop / recovery budgets already configured; pin the constant or config key in tasks.
- If #857 event type names differ at implementation time, map by documented field contract rather than hard-coding provisional names in living specs beyond scenarios.
