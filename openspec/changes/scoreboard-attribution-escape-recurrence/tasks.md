## 1. Shared attribution primitives

- [ ] 1.1 Define closed `DiscoveryChannel` const + type (`live-run` | `review-batch` | `papercut-autofile` | `manual`) in a small core module (e.g. near `engine-identity` / intervention types).
- [ ] 1.2 Extend engine identity resolution with `commit_sha` when the engine root is a git checkout; pure helper with injected exec/fs deps; never invent SHA.
- [ ] 1.3 Implement pure marker formatters/parsers for GitHub HTML comments (engine version+sha, discovery-channel) that compose with existing auto-file provenance markers.
- [ ] 1.4 Unit tests: closed channel set; SHA resolve/unresolve; marker round-trip; markers survive sanitization denylist on adjacent free text.

## 2. Run identity and event enrichment

- [ ] 2.1 Add `commit_sha` to `run.json` `engine` object at `initRunDir` when resolvable; keep write-once semantics.
- [ ] 2.2 Document and implement inheritance rule: events may omit inline fields and inherit `engine_version` / `engine_commit_sha` / default `discovery_channel` from run identity (default `live-run` for ordinary advance).
- [ ] 2.3 Enrich `human_intervention` emission (and other defect/blocker/recovery-result append paths in scope) with additive attribution fields or inheritance hooks without changing non-fatal emission behavior.
- [ ] 2.4 Stamp engine + discovery-channel on engine-posted blocker comments.
- [ ] 2.5 Injected-deps tests: run.json with/without SHA; intervention event readable by collectors; historical events without fields do not crash.

## 3. Auto-file body stamping

- [ ] 3.1 Papercut auto-file body builder: add engine + discovery-channel stamps; keep `AUTO_FILE_PROVENANCE_MARKER` and rate-cap behavior unchanged.
- [ ] 3.2 Correction auto-file body builder: same stamps; keep correction marker + independent budget.
- [ ] 3.3 Durable-run-blocker auto-file body builder: same stamps; keep durable marker + independent budget.
- [ ] 3.4 Regression tests: each category marker still drives only its own cap; discovery-channel always `papercut-autofile` for all three; unresolved SHA path still files.

## 4. Escape-recurrence registry and pure metrics

- [ ] 4.1 Implement seed defect-class key registry (`delta-sha-gate`, `openspec-archive`, `salvage`, `worktree`) + pure mapper from ledger/attribution signals.
- [ ] 4.2 Implement fix-boundary resolution (control_attribution `effective_release` / release observations priority) and post-boundary recurrence pure function returning `RateValue` + per-key rows + missing-boundary diagnostics.
- [ ] 4.3 Unit tests: seed strings locked; pre-boundary not recurrent; post-boundary recurrent; zero boundaries → null ratio; unmapped signals excluded from denom.

## 5. Scoreboard collectors — human touch, discovery, escape, release trend

- [ ] 5.1 Human-touch aggregates: by-kind counts; per-attempted and per-R2D `RateValue`s; no labor-minutes derivation.
- [ ] 5.2 Discovery-channel decomposition with missing-attribution bucket (not default live-run).
- [ ] 5.3 Wire escape-recurrence aggregate into scoreboard JSON + human output.
- [ ] 5.4 Release-over-release engine-class needs-human/rate series: prefer FRG trend ledger when present; fallback + diagnostic when absent; do not re-score FRG composition.
- [ ] 5.5 Fixtures: mixed channels; zero denom null ratios; FRG ledger present vs absent.

## 6. Scoreboard collectors — stratified stabilization + candidate integrity

- [ ] 6.1 Implement stratified metrics with named denominators (first-attempt intervention-free R2D; eventual R2D within bound; false product-judgment; engine blockers per 100 stage attempts; recovery success/exhaustion/attempts/resumes/time-by-reason; first-pass approval / fix rounds / recurring findings; green/current/mergeable R2D when evidence present; orphan followers / progress gaps / stale worktrees / false capacity waits; evidence coverage/missingness).
- [ ] 6.2 Consume canonical stage diagnostics and recovery attempt/result events (post-#787: recovered same-run blockers are not terminal off-ramps).
- [ ] 6.3 Candidate-integrity observability from #857 durable events by mutation method and engine/version; zeros + optional missing diagnostic when absent; no gate thresholds.
- [ ] 6.4 Compose new metrics with `--bucket day|week` (period-local) without changing full-window summary.
- [ ] 6.5 Injected-deps tests proving denominators, null ratios, recovered-blocker non-terminal semantics, and candidate-integrity zero path.

## 7. Documentation and operator query path

- [ ] 7.1 Document discovery-channel vocabulary, marker grammar, inheritance rule, and dogfood-day scoreboard queries in CLI help / relevant docs (no new required human input).
- [ ] 7.2 Note non-goals: no labor minutes; no events/day model comparison; no FRG threshold change; HTML export not required (#427 separate).

## 8. Mirror and CI gate

- [ ] 8.1 After any `core/` edits: `node scripts/build.mjs` and commit regenerated `plugin/` with the same change set.
- [ ] 8.2 Run `npm run ci` from repo root until green.
- [ ] 8.3 Confirm no auto-merge path and no FRG K/max engine-class rate value changes landed.
