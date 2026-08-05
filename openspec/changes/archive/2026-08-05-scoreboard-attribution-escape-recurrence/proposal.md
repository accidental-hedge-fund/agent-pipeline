## Why

Stabilization cannot be steered from the repo today: escape-recurrence (fixed defect classes that recur after a fix ships), human-touch accounting, discovery-channel decomposition of issue arrivals, and engine version+SHA attribution on auto-filed issues and blocker comments are untracked. Without them, regression rate is conflated with detector/batch filings, stale-install phantom P0s (#176) remain unattributable, and “are we actually getting more stable?” is not computable offline. This change is the instrumentation that question depends on (v1.31.0 factory/harness-honesty theme); it does not gate releases or merge.

## What Changes

- **Engine + discovery attribution** — every auto-filed issue body, blocker comment, and run-ledger event carries the producing engine version and commit SHA (when resolvable) plus a closed `discovery-channel` marker (`live-run` | `review-batch` | `papercut-autofile` | `manual`). Existing auto-file category provenance markers remain for reconciliation; discovery-channel is the coarse arrival channel for metrics.
- **Scoreboard: human-touch accounting** — count operator touches per attempted issue and per ready-to-deploy (R2D) issue from durable intervention/merge/override/unblock/worktree events (not wall-clock labor minutes).
- **Scoreboard: escape-recurrence** — for seeded defect-class keys (delta/SHA-gate, openspec-archive, salvage, worktree, plus extensible registry), report the fraction of classes that recur after their fix release boundary.
- **Scoreboard: engine-class needs-human release-over-release** — extend #683’s pre-merge/blocker-class rate with release-bucketed trends; consume #757 FRG release observations/trend ledger where present instead of duplicating FRG calculations.
- **Scoreboard: stratified stabilization metrics with explicit denominators** — intervention-free first-attempt R2D; eventual R2D within bounded attempts; false product-judgment rate; engine blockers per 100 stage attempts; recovery success/exhaustion/attempts/resumes/time by reason; first-pass approval, fix rounds, recurring findings; final green/current/mergeable R2D rate; orphan followers, progress gaps, stale worktrees, false capacity waits; evidence coverage and missingness. Risk/change-class stratification where durable fields support it.
- **Scoreboard: candidate-integrity observability** — consume durable #857 events and report by mutation method and engine/version: candidate-moving repairs/restacks; review/readiness invalidations from a changed candidate; scope expansions and unverified comparisons before R2D; post-repair invariant failures (path class); post-merge invariant escapes linked to originating repair/restack. Observability only — no promotion/block thresholds.
- **Evidence rules** — metrics are offline-computable from run ledgers + GitHub-authored markers with no new required human input; missing evidence is counted, never silently zeroed; rates use explicit numerators/denominators (`ratio: null` when denominator is zero). Do not infer human labor minutes from timestamps or use raw events/day as a model comparison.
- **Tests + mirror** — injected-deps unit tests; `npm run ci` green; regenerate `plugin/` when `core/` changes (implementation phase).

**Not in scope:** HTML/dashboard export (#427); any gate, auto-merge, or FRG threshold change that consumes these numbers; changing FRG K/max engine-class rate values.

## Acceptance Criteria

- [ ] Auto-filed issues (papercut, correction, durable-run-blocker) include machine-readable engine `version` + `commit_sha` (or explicit unresolved markers) and a `discovery-channel` of `papercut-autofile` (or the channel assigned by design for that filer) without breaking existing category provenance markers or rate-cap reconciliation.
- [ ] Blocker comments posted by the engine include the same engine identity fields and discovery-channel when the channel is known; missing identity is an explicit missing-evidence diagnostic, not a silent omit that scoreboard treats as “no version.”
- [ ] Run-ledger events that create or classify defects/blockers (including `human_intervention`, stage diagnostics / recovery attempt/result, and auto-file related events) carry engine version+SHA and discovery-channel fields (or inherit from `run.json` with a documented inheritance rule proven by tests).
- [ ] `run.json` / engine identity records a git commit SHA for the engine when resolvable, additive to existing `version` / `root` / `templates_fingerprint`.
- [ ] `pipeline scoreboard --json` exposes: human-touches per attempted issue and per R2D issue; escape-recurrence aggregate for seeded defect-class keys; engine-class needs-human (or engine-class rate) release-over-release series; discovery-channel decomposition of arrivals; each stabilization metric named in What Changes with **explicit numerator, denominator, and ratio** (null ratio when denom=0).
- [ ] Escape-recurrence uses a fix-release boundary (tag or `control_attribution.effective_release` / documented equivalent) and counts a class as recurrent only when a new occurrence appears **after** that boundary; seed keys include delta/SHA-gate, openspec-archive, salvage, and worktree.
- [ ] Human-touch accounting counts discrete touch kinds (override, unblock, merge authority click when recorded, hand stage-tag when recorded, manual worktree remove when recorded) and does **not** convert wall-clock intervals into labor minutes.
- [ ] Scoreboard release trends prefer #757 FRG trend-ledger / release observation artifacts when present; they do not re-score FRG pack composition or invent a second engine-class rate definition.
- [ ] Candidate-integrity metrics appear when #857 durable events exist; when events are absent, metrics report zero counts with missing-evidence diagnostics rather than fabricating rates.
- [ ] Metrics consume canonical stage diagnostics and recovery attempt/result events (post-#787); they do not infer terminal off-ramp classes solely from labels or free-text comments.
- [ ] All new aggregates are computable offline from local ledgers and optional read-only GitHub reads of already-authored markers; no new required operator diary or human classification step.
- [ ] Injected-deps unit/regression tests cover stamping, each new scoreboard aggregate’s denominator rules, escape-recurrence boundary, missing-evidence paths, and at least one fixture that would fail without the fix for each major metric family.
- [ ] `npm run ci` green; `plugin/` regenerated in the same change set as any `core/` edits (implementation phase).
- [ ] No new auto-merge path, no FRG threshold change, and no HTML-only dashboard dependency for these metrics.

## Capabilities

### New Capabilities

- `engine-discovery-attribution`: Closed discovery-channel vocabulary; engine version+commit SHA stamping on auto-filed issues, blocker comments, and run-ledger events; inheritance from run identity; missing-identity diagnostics.
- `escape-recurrence-tracking`: Defect-class key registry (seed keys + extensibility), fix-release boundary rules, and recurrence counting contract consumed by the scoreboard.

### Modified Capabilities

- `factory-scoreboard`: Human-touch rates; escape-recurrence aggregate; release-over-release engine-class needs-human trend; discovery-channel decomposition; stratified stabilization metrics with explicit denominators and evidence coverage/missingness; candidate-integrity observability metrics; consume FRG observations rather than duplicating FRG math.
- `run-directory-layout`: Additive engine commit SHA (and any discovery context pinned at run init when known) on `run.json` engine identity.
- `papercut-auto-file`: Stamp engine identity + discovery-channel on auto-filed issue bodies (additive markers).
- `correction-auto-file`: Same stamping contract for correction auto-filed issues.
- `durable-run-blocker-auto-file`: Same stamping contract for durable-run-blocker auto-filed issues.
- `human-intervention-events`: Ensure intervention/touch events carry or inherit engine + discovery attribution needed for human-touch accounting (additive fields).

## Impact

- **Specs:** new `engine-discovery-attribution`, `escape-recurrence-tracking`; deltas on `factory-scoreboard`, `run-directory-layout`, three auto-file capabilities, `human-intervention-events`.
- **Code (implementation phase only):** auto-file body builders (`papercut.ts` and siblings); blocker comment emitters; `run-store` / `engine-identity` / event append path; `scoreboard.ts` collectors and formatters; optional thin readers of FRG trend ledger and GitHub markers; `plugin/` regen.
- **Dependencies:** #633 / #757 / #760 / #787 / #857 behavior and durable event shapes — consume, do not reimplement FRG or candidate-integrity control planes.
- **Operators:** no new required input; scoreboard grows additive JSON/human sections; existing flags (`--json`, `--bucket`, window filters) remain the query surface.
- **Does not:** change merge authority, introduce unattended merge, tighten FRG thresholds, or ship HTML dashboards.
