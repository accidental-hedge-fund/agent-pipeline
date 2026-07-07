## 1. Doctor `warn` status model

- [x] 1.1 Extend `CheckStatus` in `core/scripts/stages/doctor.ts` with `"warn"` and add a `warn(detail, remediation)` result constructor.
- [x] 1.2 Keep `PreflightResult.ok` true for `warn` (only `fail` sets `ok:false`); confirm exit codes and `runOnStart` gating treat `warn` as non-blocking.
- [x] 1.3 Render `warn` in `formatDoctorSummary` with its own symbol and remediation line, and add `warn` to the counts line.
- [x] 1.4 Update `formatDoctorJson`: add per-check `status` field, keep `ok = status !== "fail"`, and set top-level envelope `status` to `"warnings"` when there is ≥1 `warn` and 0 `fail`.

## 2. `install:version-freshness` check

- [x] 2.1 Add the check to `buildPreflightChecks`, keyed by the fixed upstream repo constant `accidental-hedge-fund/agent-pipeline` (not `config.repo`).
- [x] 2.2 Query the latest release via `DoctorDeps.exec("gh", ["release", "view", "--repo", <slug>, "--json", "tagName"])` and parse `tagName`.
- [x] 2.3 Normalize the leading `v` on both the tag and the running `VERSION`, then compare dotted numeric segments: installed `>=` latest ⇒ `pass`; installed `<` latest ⇒ `warn` naming both versions and the update remediation.
- [x] 2.4 Degrade to `skip("skipped (offline)")` on any `gh` non-zero exit, empty/unparseable output, missing `tagName`, or empty running `VERSION` — never `warn`/`fail`.
- [x] 2.5 Make the check report-only (no filesystem/network mutation of the install).

## 3. Update command + docs

- [x] 3.1 Confirm the installer `update` verb refreshes in place idempotently; add a regression/smoke assertion if not already covered.
- [x] 3.2 Document the one-step update command (`npx github:accidental-hedge-fund/agent-pipeline update`) in the README and host skill docs.
- [x] 3.3 Make the freshness check's `warn` remediation name that documented update command.

## 4. Run-start surfacing

- [x] 4.1 Verify `--doctor` / `doctor.runOnStart` include the freshness check and that a `warn` prints but does not abort before planning.

## 5. Tests, mirror, CI

- [x] 5.1 Unit-test behind→warn, up-to-date→pass, ahead-of-release→pass, and offline→skip through injected `DoctorDeps` (fake `exec` + injected `version`); no real network/git/subprocess.
- [x] 5.2 Unit-test `formatDoctorSummary` and `formatDoctorJson` for a `warn`-only result: exit stays 0, envelope `status` is `"warnings"`, per-check `status` is `"warn"`.
- [x] 5.3 Regenerate the `plugin/` mirror (`node scripts/build.mjs`) and commit it.
- [x] 5.4 Run `npm run ci` from the repo root and confirm green (includes `openspec validate --all`).
