## Context

See `proposal.md` for motivation. This is a factory-gate-v1 `clean-docs`
instance. The work is a checked-in JSON fixture plus one unit test.
`scripts/build.mjs` copies `core/scripts`, `core/profiles`, and
`core/package.json` / `package-lock.json` into `plugin/`. It does not
copy `core/test/`.

## Goals / Non-Goals

**Goals:**

- Pin release `1.39.9` in a file whose path includes pack run
  `pack-1399-tugboat-ship-1.39.9`.
- Make that pin fail a unit test when the value changes.
- Keep the diff inside `core/test/` (plus this OpenSpec change).

**Non-Goals:**

- Changing FRG templates, the FRG driver, stages, merge, or ship path.
- Regenerating `plugin/` (no mirrored `core/` path is edited).
- Sharing this fixture with other pack runs.

## Decisions

1. **Minimal JSON, one required field.**
   The fixture is `{"release_version":"1.39.9"}` (pretty-printed is
   fine). Extra pack metadata is optional and unused. Alternative:
   copy the full `pipeline-frg-instance@1` header into JSON. Rejected
   because the issue only requires `release_version`.

2. **Co-located `node:test` file under `core/test/`.**
   Read the fixture with `fs.readFileSync` relative to the test file
   (or repo root via `import.meta.url`). Assert strict equality on
   `release_version`. No `deps` seam: the test reads a checked-in
   file and does no network, git, or subprocess I/O. Alternative: fold
   the assertion into an existing FRG test. Rejected so the run-scoped
   path stays obvious and isolated.

3. **No `plugin/` regeneration.**
   Tests are not in `CORE_ENTRIES`. Hand-editing `plugin/` is forbidden.
   If implementation later touches `core/scripts/`, that would violate
   the spec and would then require `node scripts/build.mjs`.

4. **Class stays in the existing template.**
   Do not edit `templates/clean-docs.md` or the factory-gate-v1
   manifest. This issue is one instance of that class.

## Risks / Trade-offs

- [Risk] A living spec named `frg-pack-1399-clean-docs` would be noise
  if this PR merged. → Mitigation: FRG closes the synthetic PR without
  merge after it records the run. Do not treat archive-on-branch as
  production law on `main`.
- [Risk] The test could pass by hard-coding `1.39.9` without reading
  the fixture. → Mitigation: the test MUST parse the run-scoped JSON
  file; tasks require a bite check (wrong version fails).
- [Risk] Implementer edits production scripts “while here”. → Mitigation:
  spec forbids `core/scripts/` edits. Review treats any such diff as
  out of scope.

## Migration Plan

No production migration. Add the fixture and test on this branch.
Roll back by dropping those files. No data or config migration.
