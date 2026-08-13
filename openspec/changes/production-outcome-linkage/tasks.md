## 1. Schema and pure validation

- [ ] 1.1 Define TypeScript types and closed enums for `outcome_kind`, `observation_state`, delivery/merge/deploy/rollback statuses, attribution `method`/`authority`, and `schema_version: 1` `production_outcome` shape in a dedicated core module (e.g. `core/scripts/outcomes/schema.ts`).
- [ ] 1.2 Implement pure validators that accept well-formed records, reject out-of-enum values, and forbid inventing placeholder SHAs/run ids in required identity positions.
- [ ] 1.3 Unit tests: closed enums locked; delivery required fields for `delivery` kind; unknown fields ignored by reader helpers; redaction applied to free text before serialize.

## 2. Host-local outcome store

- [ ] 2.1 Implement store path under `.agent-pipeline/outcomes/` (per-outcome JSON and/or append index) with injectable fs deps; create-on-write; empty store reads as zero records.
- [ ] 2.2 Implement idempotent upsert by `outcome_id`; re-ingest same id replaces/merges per documented rule without duplicate facts.
- [ ] 2.3 Implement retention filter (configurable window) excluding expired records from default list/scoreboard queries.
- [ ] 2.4 Unit tests: empty store; upsert idempotency; retention exclusion; write failure non-fatal where specified.

## 3. Linkage helpers

- [ ] 3.1 Pure helpers to build attribution entries from run store identity, `Issue`/`Pipeline-Run` trailers, and adapter signal fields.
- [ ] 3.2 Classify `authority: observed` vs `inferred` per outcome-linkage rules; emit `linkage_diagnostics` reason codes for unresolved targets.
- [ ] 3.3 Support many-to-many attribution arrays and disputed state without forcing a single primary target.
- [ ] 3.4 Unit tests: trailer→run observed; unresolved run diagnostic; temporal-only join inferred; multi-target and disputed fixtures.

## 4. Source-adapter contract and GitHub E2E adapter

- [ ] 4.1 Define adapter interface (`id`, discover/fetch with deps, normalize → records) and registry of built-in adapters.
- [ ] 4.2 Implement GitHub-native adapter: merge signals, revert signals, optional deployment/environment signals from fixtures/injectable `gh`.
- [ ] 4.3 Normalize merge without inventing deploy success; set `not_observed`/`unknown` when deployment data absent.
- [ ] 4.4 Derive stable `outcome_id` from adapter id + signal identity; batch ingest continues after one bad signal.
- [ ] 4.5 Unit tests: fixture merge → delivery with observed run link; fixture revert → reversion; no-network; idempotent re-ingest.

## 5. Operator entrypoint

- [ ] 5.1 Add CLI surface (e.g. `pipeline outcomes ingest|list`) with `--json` / dry-run summary: written, skipped, diagnostics.
- [ ] 5.2 Ensure ingest path performs no GitHub-mutating operations and no stage/label transitions.
- [ ] 5.3 Wire help text / brief docs note on privacy (host-local default, redaction, retention) and R2D ≠ production delivery.
- [ ] 5.4 Tests for CLI parsing and summary shape with injected deps (no live gh).

## 6. Scoreboard reporting

- [ ] 6.1 Extend `pipeline scoreboard` collectors to read outcome store over the report window.
- [ ] 6.2 Emit additive `outcomes` section: counts by kind, by observation_state, observed vs inferred attribution partitions; no collapsed maintainability score.
- [ ] 6.3 Human-readable section mirrors JSON distinctions; missing store → zeros + optional diagnostic.
- [ ] 6.4 Unit tests: kind counts; inferred-only not counted as observed failure; delivery merge-without-deploy not counted as deploy success.

## 7. Mirror, OpenSpec, and CI

- [ ] 7.1 After any `core/` edits: `node scripts/build.mjs` and commit regenerated `plugin/` with the same change set.
- [ ] 7.2 Run `openspec validate production-outcome-linkage` (and `openspec validate --all` in CI path) until green.
- [ ] 7.3 Run `npm run ci` from repo root until green.
- [ ] 7.4 Confirm no auto-merge path, no FRG threshold change, and no single maintainability score field landed.
