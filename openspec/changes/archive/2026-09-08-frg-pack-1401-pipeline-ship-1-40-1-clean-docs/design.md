## Context

The living `factory-reliability-gate` specification already defines generated clean-fixture
lifecycle partitioning, and `core/test/frg-fixture-lifecycle-contract.test.ts` verifies that the
real pack templates carry that partition through ordinary admission and planning. This change is
one rendered clean-path observation for release `1.40.1`; it does not repair or extend the engine.

## Goals / Non-Goals

**Goals:**

- Bind the fixture and test to the exact pack run and release identities from issue `#1553`.
- Make release-value drift fail deterministically through the smallest existing test seam.
- Keep pre-archive implementation work distinct from later Pipeline/FRG observations.

**Non-Goals:**

- Add a generalized fixture loader, schema, helper, classifier, recovery recipe, gate, controller,
  or scheduler.
- Change production behavior or automate lifecycle state from the test.
- Validate other fields, other fixtures, other pack runs, or other releases.

## Decisions

### 1. Use the exact run-scoped fixture and test paths

The implementation will use the two paths rendered into the issue body. The test will address the
single fixture directly rather than discovering fixtures with a glob or routing through a shared
pack loader.

This is the first reusable holding rung already provided by the clean-fixture contract: a plain
JSON fixture plus a direct Node test. A generalized fixture abstraction is rejected because this
issue has one literal assertion and no production reuse case.

### 2. Assert the release string literally

The test will parse the fixture and compare `release_version` directly with `"1.40.1"`. It will
not derive the expected value from the fixture path, package metadata, environment, or production
configuration.

A derived expectation is rejected because the regression must bite when the fixture value alone
changes. Node's existing test runner and strict assertion support are sufficient; no dependency is
needed.

### 3. Keep controller observations out of the implementation checklist

`tasks.md` will end after the fixture, regression test, bite check, targeted test, scope inspection,
and full CI pass. OpenSpec archive, ready-to-deploy, and FRG close-without-merge remain normative
spec scenarios observed later by Pipeline/FRG.

Putting those future states in `tasks.md` is rejected because pre-merge cannot archive a change
with unchecked tasks, while checking them before they occur would fabricate evidence.

## Risks / Trade-offs

- **[Risk] A test-derived expected version could pass after fixture drift** -> Mitigation: compare
  against a literal `1.40.1` and prove the test fails for a changed fixture value.
- **[Risk] The fixture exercise expands into production self-host work** -> Mitigation: restrict
  implementation to the exact run-scoped paths and use the existing lifecycle controller.
- **[Risk] Future lifecycle evidence is confused with pre-archive work** -> Mitigation: keep it in
  requirements and scenarios only, with no corresponding unchecked task.
- **[Trade-off] The direct test duplicates a small amount of file-reading setup** -> Accepted to
  keep this synthetic observation isolated and falsifiable without a custom abstraction.
