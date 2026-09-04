## Context

See `proposal.md` for why.

`core/test/fixtures/frg/` does not exist yet. Other unit tests already load
repo-local JSON with `readFileSync` and `JSON.parse` (for example
`core/test/declared-dependency-grammar.test.ts` and
`core/test/outer-host-lifecycle.test.ts`). Production code under
`core/scripts/` has no consumer for this pack fixture.

## Goals / Non-Goals

**Goals:**

- Stop at the first holding reuse rung: a static JSON file plus one
  `node:test` file that reads it. No new helper, loader, config key, or
  production API.
- Keep the fixture path exactly
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`.
- Keep `release_version` as the string `1.40.1`.

**Non-Goals:**

- Production behavior changes.
- A shared FRG fixture schema or loader used by later packs.
- Classifier, recipe, gate, or controller changes (this is a synthetic pack
  item, not an engine recover fault).
- Merge, auto-merge, or a second scheduler.

## Decisions

### D1 — Static JSON plus existing `node:test` read pattern

Add the fixture as a committed JSON file. The unit test joins
`import.meta.url` to `fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`,
reads UTF-8, parses JSON, and asserts `release_version === "1.40.1"`.

**Alternative considered:** import JSON through a new helper. Rejected: the
existing tests already use `readFileSync` + `JSON.parse`. A helper is a custom
layer this pack does not need.

**Alternative considered:** embed the version in the test only. Rejected: the
issue requires a run-scoped JSON fixture.

### D2 — Field name `release_version`

The factory-gate template names the pack field `release_version` and the
sibling `clean-docs` work verifies that same field. Use that key. Do not
invent `version`, `release`, or a nested provenance object.

**Alternative considered:** copy the full pack provenance block
(`pack_id`, `pack_run_id`, `template_id`, …). Rejected: the issue asks for one
requirement that the fixture names release `1.40.1`. Extra keys are out of
scope.

### D3 — New capability, not a `factory-reliability-gate` delta

Keep the requirement in `frg-pack-1401-clean-openspec`. Do not add a
run-scoped fixture contract to the living factory-gate spec.

**Alternative considered:** modify `factory-reliability-gate`. Rejected: that
spec is production FRG law. This pack item is synthetic and must stay isolated.

### D4 — Test file under `core/test/`

Name the test file after the pack path, for example
`core/test/frg-pack-1401-clean-openspec.test.ts`. Run it through the existing
`core` `node:test` glob. Do not add a new npm script.

## Risks / Trade-offs

- [Risk] A later pack copies this fixture into a shared path → Mitigation: the
  spec and test bind the exact `pack-1401-pipeline-ship-1.40.1` path.
- [Risk] Pre-merge archive leaves this as the only active change → Mitigation:
  do not author a second change directory for #1437.
- [Risk] `npm run ci` regenerates host SKILLs after `core/` edits → Mitigation:
  this change does not edit `core/scripts/`. If a later implement step only
  adds `core/test/`, still run `npm run ci`. Run `node scripts/build.mjs` only
  if `core/` production sources change.
