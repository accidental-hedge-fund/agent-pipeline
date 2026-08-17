## 1. Shared production-quality classifier

- [x] 1.1 Add a hermetic helper that treats a pin (or FRG `run_id`) as non-production-quality when `frg_run_id` starts with `no-frg-` or `frg_evidence_path` is null/empty
- [x] 1.2 Keep `parseProductionEnginePin` permissive so a `no-frg-*` / null-evidence pin still parses for doctor and rollback

## 2. Default promote refuses no-frg

- [x] 2.1 In `promoteProductionPin` (non-skip), refuse when FRG is missing, `pass: false`, unparsable, `run_id` starts with `no-frg-`, or the write would leave `frg_evidence_path` null. Leave the pin file unchanged
- [x] 2.2 On non-skip success, write `frg_run_id` from the FRG evidence `run_id` and a non-null evidence path. Do not write `no-frg-<version>`
- [x] 2.3 Leave `allowWithoutFrg` / resolved skip as the only writer of `no-frg-<version>` + null evidence. `factory-pin promote` stays FRG-only
- [x] 2.4 Do not invent `git_sha` values. Do not merge or tag

## 3. Engine-promote already-current

- [x] 3.1 Treat same-version+tag as already-current success only when the live pin is production-quality, or when resolved skip is active
- [x] 3.2 When the live pin is `no-frg-*` / null evidence for the target version and skip is off, refuse or re-promote from a real FRG pass. Do not return success with the marker pin

## 4. Doctor install:engine-track

- [x] 4.1 In `evaluateEngineTrackCheck`, fail under pinned intent when the loaded pin is not production-quality, even if version and tag-install provenance match
- [x] 4.2 Name the `no-frg-*` / null-evidence defect in detail and remediate with non-skip promote from a real FRG pass
- [x] 4.3 Do not fail solely for this marker when two-track policy is inactive (non-factory) or when intent is candidate (report the marker in detail)

## 5. Tests

- [x] 5.1 Prove default `promoteProductionPin` refuses `no-frg-*` / missing FRG / null evidence and does not mutate the pin. The test must fail against current `allowWithoutFrg` default success if that path is used without skip
- [x] 5.2 Prove non-skip success writes the FRG `run_id` and a non-null evidence path, not `no-frg-*`
- [x] 5.3 Prove resolved skip still writes `no-frg-<version>` + null evidence
- [x] 5.4 Prove engine-promote does not treat a same-version `no-frg-*` pin as already-current when skip is off
- [x] 5.5 Prove factory pinned `evaluateEngineTrackCheck` fails a matching-version `no-frg-*` pin, and that non-factory / candidate intent do not fail solely for the marker
- [x] 5.6 Tests inject I/O. They perform no real network, git, or subprocess calls

## 6. Docs, mirror, gate

- [x] 6.1 Update FRG runbook / factory-pin CLI text so a production pin after an FRG ship has a real `frg_run_id` and evidence path, and so `--skip-frg` is documented as a non-production-quality marker only
- [x] 6.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 6.3 Run `openspec validate refuse-no-frg-production-pin` and `npm run ci` from the repo root. Fix failures until green
