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

Exercise one clean Pipeline path with a small documentation fixture and its test.

## Work

Add a run-scoped JSON fixture at
`core/test/fixtures/frg/{{pack_run_id}}/clean-docs.json`. Add a unit test that reads
the fixture and verifies its `release_version` value is `{{release_version}}`.
Do not change production behavior.

## Acceptance

- The fixture and test use only the run-scoped path.
- The test fails if the fixture version changes.
- The full Pipeline reaches `pipeline:ready-to-deploy`.
- The FRG closes the pull request and issue without merge after it records the run.
