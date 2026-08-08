<!-- pipeline-frg-instance@1
pack_id={{pack_id}}
manifest_version={{manifest_version}}
manifest_sha256={{manifest_sha256}}
release_version={{release_version}}
pack_run_id={{pack_run_id}}
template_id={{template_id}}
template_sha256={{template_sha256}}
-->

## Purpose

Exercise one clean Pipeline path that includes an OpenSpec change and archive.

## Work

Add a run-scoped JSON fixture at
`core/test/fixtures/frg/{{pack_run_id}}/clean-openspec.json`. Propose one OpenSpec
requirement that states the fixture must name release `{{release_version}}`. Add a
unit test that verifies this value. Do not change production behavior.

## Acceptance

- The active OpenSpec change belongs only to this synthetic issue.
- The fixture and test use only the run-scoped path.
- Pre-merge archives the OpenSpec change and leaves no foreign active change.
- The full Pipeline reaches `pipeline:ready-to-deploy`.
- The FRG closes the pull request and issue without merge after it records the run.
