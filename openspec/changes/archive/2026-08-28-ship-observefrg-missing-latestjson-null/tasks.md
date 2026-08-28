## 1. Shared observe mapping (no formatter substring)

- [x] 1.1 Add a typed tag-path ineligibility signal (or a helper next to the shared tag validator) that maps missing, unreadable, and not-release-eligible `latest.json` to not-observed without reading `formatFrgTagPathFailure` copy; verify a unit test fails if classification uses `message.includes("evidence missing")` (or any other formatter substring) as the only not-observed signal.
- [x] 1.2 Keep `validateFrgEvidenceFileForTag` / `--validate-tag` / `release ensure-tag` fail-closed on the same missing or ineligible file; verify existing `core/test/factory-reliability-gate.test.ts` tag-path tests still reject ENOENT and `pass: false` with `formatFrgTagPathFailure` path + pack remediation.

## 2. observeFrg and ship coordinator

- [x] 2.1 Drive production `observeFrg` (or an extracted observe helper with injected `FrgFsDeps`) so ENOENT `latest.json` for `1.39.14` returns `null`; verify the test fails on today's `"evidence missing"` catch (throws `Cannot create or push tag`).
- [x] 2.2 Same seam: unreadable and `pass: false` / not-release-eligible `latest.json` return `null`; a release-eligible HMAC pass returns evidence; verify identity defects (base advanced, train not contained, HMAC candidate mismatch after a valid eligible read) still throw and do not return `null`.
- [x] 2.3 After proven train evidence and observe-null, verify coordinator `next_action` is `frg_pack` (not `train_merge` with `train: null`) and FRG pack / `factory-release prepare` is the next mutation; use injected coordinator deps in `core/test/ship-adapter.test.ts`.
- [x] 2.4 Verify `waitForPublication` / `ensureAnnotatedReleaseTag` still fail closed when `latest.json` is absent; an earlier observe-null does not skip ensure-tag once a later tick has (or still lacks) a release-eligible artifact.
- [x] 2.5 After the observe-null mapping, re-read `observeBase()` and fail closed if it advanced during the evidence read; verify an injected race (first base matches train, `latest.json` ENOENT, second base advanced) throws and does not return null.

## 3. Mirror and CI

- [x] 3.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes.
- [x] 3.2 Run `npm run ci` from repo root and fix failures until green.
