## 1. Injection-denylist sanitize helper

- [ ] 1.1 Create `core/scripts/artifact-sanitize.ts` exporting `INJECTION_PATTERNS` (named const array of regex) and `sanitize(content: string): string` that replaces all matches with `[REDACTED-INJECTION]`
- [ ] 1.2 Write unit tests in `core/test/artifact-sanitize.test.ts` covering: clean string unchanged, single-pattern match redacted, multi-pattern match redacted, multi-line injection caught, adjacent matches both redacted
- [ ] 1.3 Prove tests fail without the implementation (delete/stub sanitize, confirm red)

## 2. Non-fatal I/O wrapper

- [ ] 2.1 Audit all artifact write call sites in `core/scripts/`: evidence bundle (`harness.ts` or wherever `writeBundle` / `recordStage` / `finalizeBundle` are called), any `events.jsonl` appends, `summary.json` writes, `doctor --json` output path
- [ ] 2.2 Wrap each identified write in a try/catch that calls `logWarn` with the error and returns without re-throwing
- [ ] 2.3 Add unit tests asserting that a write-throwing dependency does not propagate an error out of the artifact write call (use the `deps` seam pattern)

## 3. schema_version field

- [ ] 3.1 Add `schema_version: 1` to the evidence bundle initial object (alongside the existing `schemaVersion: 1` alias — keep both during the transitional period)
- [ ] 3.2 Add `schema_version: 1` to any new artifact record types introduced by #155 (events.jsonl lines, summary.json top-level object)
- [ ] 3.3 Add `schema_version: 1` to `doctor --json` output object
- [ ] 3.4 Write regression tests asserting `schema_version` is present in each serialized output (evidence bundle, events.jsonl line, summary.json, doctor output)

## 4. Wire sanitize() at artifact write sites

- [ ] 4.1 Call `sanitize()` on the serialized JSON string immediately before every artifact write identified in task 2.1
- [ ] 4.2 Add unit tests that inject a denylist string into a field value and assert the persisted output contains `[REDACTED-INJECTION]` instead

## 5. _ prefix convention and README documentation

- [ ] 5.1 Identify all existing machine-readable record fields that are local-machine-specific (absolute paths, workspace paths)
- [ ] 5.2 Rename those fields to use a `_` prefix (e.g., `localPath` → `_localPath`); update all read/write call sites
- [ ] 5.3 Add a "Machine-readable artifact conventions" section to `README.md` documenting: `_`-prefix semantics and list of current local-only fields, `schema_version` integer and backward-compat promise, injection-denylist behavior, non-fatal I/O contract
- [ ] 5.4 Add a test asserting no `_`-prefixed field appears in any code path that would send data to a remote (if such a path exists; skip with a comment if not yet present)

## 6. Regenerate plugin mirror and CI gate

- [ ] 6.1 Run `node scripts/build.mjs` from repo root to regenerate `plugin/`
- [ ] 6.2 Run `npm run ci` from repo root; confirm all checks pass (ci:core, build.mjs --check, ci:install-smoke)
- [ ] 6.3 Fix any CI failures before marking this change done
