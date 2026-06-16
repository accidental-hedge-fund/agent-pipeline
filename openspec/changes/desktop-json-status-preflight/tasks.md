## 1. CLI flag wiring

- [ ] 1.1 Add `--json` boolean flag to the `pipeline <issue> --status` CLI parser in `core/scripts/pipeline.ts`
- [ ] 1.2 Add `--json` boolean flag to the `pipeline doctor` CLI parser
- [ ] 1.3 Add `--is-ok` boolean flag to the `pipeline doctor` CLI parser
- [ ] 1.4 Validate that `--json` and `--is-ok` are mutually exclusive; exit with an error message if both are supplied

## 2. JSON status output

- [ ] 2.1 Audit the existing `--status` code path to identify which data is already fetched (`gh issue view`, `gh pr view`, label parsing, worktree helpers, comment history)
- [ ] 2.2 Create `core/scripts/status-json.ts` with a `buildStatusPayload(issue, deps): StatusPayload` function that assembles the minimum field set (`schema_version`, `status`, `issue`, `stage`, `pr`, `branch`, `worktree`, `last_event`, `review_summary`, `next_action`, `config`)
- [ ] 2.3 Wire `--json` in the status path: when active, call `buildStatusPayload`, serialize with `JSON.stringify`, and write to stdout; skip the prose formatter
- [ ] 2.4 Ensure errors during fetch are caught and encoded as `{ status: "error", error: "..." }` rather than crashing with non-JSON output

## 3. Doctor JSON output

- [ ] 3.1 Audit the existing `runPreflight(deps: DoctorDeps)` return shape to confirm it includes per-check `{name, ok, reason, fix}` data (or add `fix` field if missing)
- [ ] 3.2 Create a `formatDoctorJson(result: PreflightResult): DoctorJsonEnvelope` formatter that maps the existing result to `{ schema_version, status, checks }` — no new check logic
- [ ] 3.3 Wire `--json` in the doctor path: call `formatDoctorJson` on the same `runPreflight` result; write JSON to stdout; suppress the prose formatter
- [ ] 3.4 Wire `--is-ok`: call `runPreflight`, suppress all output, exit 0 on all-pass / exit 1 on any-fail

## 4. Unit tests

- [ ] 4.1 Write unit tests for `buildStatusPayload` using `gh` fakes: verify minimum fields present, `schema_version: "1"`, `pr: null` when no PR, `stage: null` when no pipeline label
- [ ] 4.2 Write unit tests for `formatDoctorJson`: verify all-pass envelope (`status: "ok"`, all `ok: true`), one-fail envelope (`status: "error"`, failing entry has `ok: false` and non-empty `fix`)
- [ ] 4.3 Write unit tests for `--is-ok` mode via the injectable seam: verify exit 0 on all-pass, exit 1 on one-fail, zero bytes to stdout
- [ ] 4.4 Write a test asserting that `--json` and `--is-ok` together produce an error exit and a stderr message
- [ ] 4.5 Prove each new test bites (fails without the implementation): run tests against stubs to confirm red-before-green

## 5. Prose output regression guard

- [ ] 5.1 Extend the existing `--status` test (or add a new one) that captures the prose output and asserts it is identical before and after this change (byte-level or line-level comparison)
- [ ] 5.2 Extend the existing `doctor` test similarly for the human prose path

## 6. CI gate

- [ ] 6.1 Run `npm run ci` from repo root (core tests, mirror sync check, install smoke) — must be green before marking done
- [ ] 6.2 Regenerate `plugin/` mirror with `node scripts/build.mjs` and commit it alongside `core/` changes
