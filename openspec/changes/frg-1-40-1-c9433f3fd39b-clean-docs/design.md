## Context

See `proposal.md` for motivation. This change is a synthetic FRG clean-docs
observation for pack run `frg-1.40.1-c9433f3fd39b`. No production module, gate,
or controller is in scope.

`core/test/fixtures/frg/` does not exist yet. Nearby tests already read files
with Node stdlib (`node:test`, `node:fs`, `node:path`, `node:url`). FRG
exact-pair path checks in `core/scripts/exact-candidate-frg.ts` already name
the fixture, test, and living-spec paths this issue owns.

## Goals / Non-Goals

**Goals:**

- Add the exact JSON fixture and the exact unit test named by the issue.
- Keep the test a direct read-parse-assert of `release_version`.
- Keep `tasks.md` limited to work that can finish before pre-merge archive.
- Preserve controller-owned lifecycle obligations in the spec, not in tasks.

**Non-Goals:**

- A shared FRG fixture loader, helper, or production API.
- Observability preload, harness fakes, or network/git seams (this test does
  not call those surfaces).
- Merge, deploy, or implementer-driven close of the pull request or issue.

## Decisions

**Decision: first holding rung is Node stdlib plus one JSON file.**

After reading in-scope tests and FRG path helpers, the first holding rung is
reuse of `node:test`, `node:fs`, `node:path`, and `JSON.parse`. Do not add a
fixture schema module, test helper, or production export. Alternative
considered: a shared FRG fixture loader. Rejected: this issue owns one file
and one assertion.

**Decision: fixture body is a JSON object with `release_version` exactly `1.40.1`.**

The issue requires that field and no other product fields. Extra keys are not
needed. Alternative considered: copy a larger FRG observation record.
Rejected: that would expand scope past the named identity check.

**Decision: the test locates the fixture from the test file path.**

Resolve
`core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-docs.json` relative to
the test file with `import.meta.url`, matching existing `core/test/` file
reads. Do not hard-code a host-specific absolute path. Alternative
considered: `process.cwd()`-only lookup. Rejected: cwd is less stable when
the runner is invoked from a different directory.

**Decision: verification uses the issue-named test command.**

The issue names
`cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-c9433f3fd39b-clean-docs.test.ts`
then `npm run ci` from the repository root. This test only reads a JSON file,
so the isolated-observability preload is not required for the named command.
`npm test` still runs the file as part of the suite.

**Decision: controller lifecycle stays in the spec.**

Admission, archive, `pipeline:ready-to-deploy`, and FRG close-without-merge
are future observations. They stay in requirements and scenarios. They are
not `tasks.md` checkboxes. Alternative considered: put those items in tasks
so the issue looks complete at implementation time. Rejected: that would mark
future controller evidence done before it occurs and would block pre-merge
on work the implementer cannot finish.

## Risks / Trade-offs

- [Risk] A later implementer may add production files or a helper module. →
  Mitigation: spec and tasks name the exact two product paths. FRG
  exact-pair path checks already reject foreign files for this slot.
- [Risk] `tasks.md` may copy controller lifecycle items and fail pre-merge
  archive because those boxes cannot be checked yet. → Mitigation: tasks
  list only fixture, test, targeted test command, and `npm run ci`.
- [Risk] The targeted test command omits the observability preload used by
  other single-file runs. → Mitigation: this test does not write telemetry.
  The full `npm run ci` gate still runs the suite under the repo's normal
  test script.
