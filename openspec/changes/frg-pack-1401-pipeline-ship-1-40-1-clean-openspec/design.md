## Context

See `proposal.md` for motivation. This is a synthetic clean-path conformance fixture, not a production pipeline feature or a self-host recovery. The implementation surface is fixed to one JSON fixture and one Node test; the OpenSpec artifacts are the third issue-owned path. Some acceptance evidence occurs only after implementation, during pre-merge and FRG controller processing.

## Goals / Non-Goals

**Goals:**

- Bind the fixture to release `1.40.1` with a runtime assertion that detects drift.
- Reuse the repository's native Node test runner and existing OpenSpec/Pipeline lifecycle.
- Separate implementer-completable work from later controller-owned evidence.

**Non-Goals:**

- Change production behavior, classifiers, recovery recipes, gates, controllers, merge authority, or deployment behavior.
- Introduce a new fixture loader, test framework, lifecycle controller, or evidence format.
- Convert future controller observations into implementation checklist items.

## Decisions

### Use a literal JSON value and a direct, single-fixture test

The fixture will contain `release_version: "1.40.1"`. The test will read only the exact run-scoped fixture, parse it, and compare the parsed value to the literal expected release. This is the first reuse rung: ordinary JSON parsing plus the existing Node test runner. A shared loader or parameterized FRG abstraction would expand production surface without improving this isolated conformance observation.

Alternative considered: infer the expected version from a path, package metadata, or environment input. Rejected because it could allow the fixture and derived expectation to drift together, weakening the required literal regression signal.

### Keep lifecycle evidence normative but outside implementer tasks

The single spec requirement includes scenarios for admission/review rigor, issue-owned archival, ready-to-deploy without merge, and controller closure without merge. `tasks.md` will contain only fixture creation, test creation, and verification available before pre-merge archive. The later events remain controller-owned acceptance evidence.

Alternative considered: list the later lifecycle events as tasks. Rejected because an implementer cannot truthfully complete them before pre-merge and the FRG controller execute.

### Use an issue-specific capability

The change adds `frg-clean-openspec-fixture` rather than modifying the broad `factory-reliability-gate` capability. This fixture observes existing FRG behavior and does not alter the production contract. Archival can therefore preserve a focused historical contract without implying a reusable production feature.

Alternative considered: modify `factory-reliability-gate`. Rejected because that would misrepresent a run-scoped test fixture as a production FRG behavior change.

## Risks / Trade-offs

- [Issue-specific living spec has narrow reuse] → Keep the capability explicitly run-scoped so it records conformance intent without broadening production semantics.
- [A test could accidentally read broader configuration] → Require the test to read only the exact fixture and compare against a literal.
- [Controller evidence could be claimed prematurely] → Keep those observations out of `tasks.md` and leave their acceptance checkboxes open until the controller records them.

## Migration Plan

No migration or production rollout is required. Implement the two run-scoped test files, run the targeted test and repository gates, then allow the normal Pipeline pre-merge and FRG controller lifecycle to produce the remaining evidence. Reverting consists of removing only the run-scoped fixture, test, and issue-owned OpenSpec artifacts before archival.
