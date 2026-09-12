## Context

See `proposal.md` for motivation. This is a clean-path FRG observation for
pack run `frg-1.40.1-c9433f3fd39b`. Existing `core/test/*.test.ts` files
already parse JSON with `node:test`, `node:assert/strict`, and
`fs.readFileSync` (for example `core/test/version.test.ts`). No production
FRG runner, classifier, or controller code is in scope.

## Goals / Non-Goals

**Goals:**
- Keep the product diff inside the three run-scoped paths named in the issue.
- Reuse the existing Node test and JSON-parse pattern. Do not add a helper,
  wrapper, or fixture runner.
- Keep `tasks.md` limited to implementer-owned work that can finish before
  pre-merge archive. Keep controller lifecycle in the spec delta.

**Non-Goals:**
- No production behavior change.
- No new test harness, observability seam, or dependency.
- No merge, deploy, release, or manual lifecycle-state change.

## Decisions

### Dedicated capability, not `factory-reliability-gate`

The exact-pair archive allowance names
`openspec/specs/frg-1-40-1-c9433f3fd39b-clean-openspec/spec.md` as the only
living-spec destination. A delta against `factory-reliability-gate` would
archive into the wrong spec. This change therefore adds one new capability
with that exact id.

Alternative considered: fold the fixture requirement into
`factory-reliability-gate`. Rejected because that living spec is production
FRG law and is not the archive destination this fixture owns.

### First holding rung: stdlib JSON read in a Node unit test

After reading in-scope tests, the first holding rung is the existing
`node:test` plus `JSON.parse(fs.readFileSync(...))` pattern. The fixture is
a JSON object with `release_version` exactly `1.40.1`. The test resolves
`core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-openspec.json` from
the test file and asserts the literal string. No new helper module.

Alternative considered: import the JSON as an ES module or add a shared FRG
fixture loader. Rejected as an extra layer the implementer would have to
build.

### Focused verification command stays as named by the issue

The implementer-owned check is:

`cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-c9433f3fd39b-clean-openspec.test.ts`

`npm test` already loads `./test/helpers/isolated-observability.ts`. The
fixture test does not write observability, so the issue-named command is
enough for the focused check. The full gate remains `npm run ci`.

### Lifecycle partition

`tasks.md` lists only fixture creation, the unit test, the focused test
command, `openspec validate --all`, and `npm run ci`. Archive,
ready-to-deploy, non-merge, and post-recording close stay in the spec
delta. They are not implementer checklist items.

## Risks / Trade-offs

- [Risk] A later implementer copies controller observations into `tasks.md`,
  which then blocks archive forever. → Mitigation: the spec forbids those
  items in `tasks.md`, and this design names the implementer-only list.
- [Risk] The fixture test is too weak to fail on a changed release value. →
  Mitigation: the spec requires a literal `1.40.1` assertion; the
  implementer proves the test fails when that value changes.
- [Risk] Archive lands in a foreign living spec. → Mitigation: the only
  allowed destination is
  `openspec/specs/frg-1-40-1-c9433f3fd39b-clean-openspec/spec.md`.

## Migration Plan

Additive only. Rollback is deletion of the three run-scoped paths. No
data migration and no production deploy.
