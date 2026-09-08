<!-- pipeline-frg-instance@1
pack_id={{pack_id}}
manifest_version={{manifest_version}}
manifest_sha256={{manifest_sha256}}
release_version={{release_version}}
pack_run_id={{pack_run_id}}
template_id={{template_id}}
template_sha256={{template_sha256}}
-->

## Summary

Exercise one synthetic clean-path conformance fixture for Pipeline release
`{{release_version}}`, including the shared OpenSpec planning and archive
lifecycle. This issue verifies that clean path; it does not change production
behavior and is not a production self-host repair. No shared classifier,
recovery recipe, gate, or controller changes are required because this is a
clean-path observation.

The repeatable unit test detects a changed release value. The FRG controller's
recorded lifecycle evidence detects a failure of the same OpenSpec lifecycle
without converting future controller observations into implementation work.

## Implementer-owned work and verification

The product diff is limited to these exact run-scoped paths and the one
issue-owned OpenSpec change created by planning:

- `core/test/fixtures/frg/{{pack_run_id}}/clean-openspec.json`
- `core/test/frg-{{pack_run_id}}-clean-openspec.test.ts`
- `openspec/changes/{{openspec_change_id}}/`

Create the JSON fixture with `release_version` exactly `{{release_version}}`.
Create the executable Node unit test at the exact path above. It must read only
that exact fixture, parse it, and assert the literal release value. The OpenSpec
change must belong only to this issue and contain one requirement that the
fixture names release `{{release_version}}`. Run:

`cd core && node --test --experimental-strip-types test/frg-{{pack_run_id}}-clean-openspec.test.ts`

Then run `openspec validate --all` and `npm run ci` from the repository root.
The test must fail if the fixture's release value changes. Do not edit production
behavior, another run's fixtures, or another issue's OpenSpec change.

## Controller-owned lifecycle evidence

These are future observations owned by Pipeline/FRG after implementation. They
remain required acceptance evidence, but they are not implementer checklist
items and must not be copied into `tasks.md` or checked before they occur:

- The issue receives normal issue-readiness admission, planning, plan review,
  implementation, and review; the fixture gets no label-only bypass or reduced
  rigor.
- Pre-merge archives this issue's OpenSpec change and leaves no foreign active
  change.
- The full Pipeline reaches `pipeline:ready-to-deploy`; advance does not merge
  or deploy.
- After the FRG records the run, the FRG controller closes the pull request and
  issue without merge.

The OpenSpec plan must preserve these lifecycle obligations in requirements and
scenarios or another controller-evidence surface while keeping `tasks.md`
limited to implementer-owned work and verification that can finish before the
pre-merge archive.

## Out of scope

- Production behavior, classifiers, recovery recipes, gates, or controllers.
- Merge, deployment, release, or manual lifecycle-state changes.
- Files outside the exact run-scoped fixture/test/OpenSpec paths.
