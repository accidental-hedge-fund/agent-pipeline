## Context

The existing Factory Reliability Gate contract already defines generated clean fixtures as synthetic observations that use ordinary Pipeline rigor and partition pre-archive implementation from controller-owned future evidence. This instance needs only run-scoped data and an executable assertion; production behavior is unchanged.

## Goals / Non-Goals

**Goals:**

- Bind one fixture and test to the `pack-1401-pipeline-ship-1.40.1` / `clean-docs` identity.
- Make a release-value mutation fail deterministically.
- Keep later lifecycle observations required without making them impossible pre-archive checklist items.

**Non-Goals:**

- Add or modify shared classifiers, recovery recipes, gates, controllers, or production code.
- Add lifecycle shortcuts, merging, deployment, or manual state transitions.
- Generalize the one-run fixture into a new abstraction.

## Decisions

### Use the existing fixture-and-Node-test seam

The first available reuse rung is the repository's checked-in JSON fixture plus native `node:test` pattern. The implementation will add one literal-value fixture and one test at the issue-prescribed paths. The test will directly read and parse that exact file, then compare `release_version` with the literal `1.40.1`.

This is preferred to adding a helper, shared loader, schema, or production FRG code because the required observation is deliberately run-scoped and the direct assertion makes fixture drift visible.

### Keep lifecycle evidence out of tasks

The spec carries ordinary admission/review, archive, ready-to-deploy, and FRG cleanup as required scenarios. `tasks.md` will contain only fixture creation, the executable test, and verification that can finish before pre-merge archive.

This is preferred to checklist entries for future controller events because unchecked entries would prevent the archive that must occur before those events, while pre-checking them would claim evidence that does not yet exist.

### Treat the fixture as observation, not engine repair

No class-level recovery change is needed: the issue declares a clean-path conformance observation rather than a production self-host failure. A future lifecycle failure remains FRG controller evidence and does not turn this fixture implementation into a path-local production repair.

## Risks / Trade-offs

- **[Risk] A broad test helper could accidentally read another run's fixture.** → Keep the test path literal and assert that release value directly.
- **[Risk] Future controller events could be mistaken for implementer work.** → Preserve them in spec scenarios and omit them from `tasks.md`.
- **[Trade-off] The test intentionally duplicates a literal release value.** → The duplication is the change detector required by this conformance instance.
