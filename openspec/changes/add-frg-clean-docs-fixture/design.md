## Context

See `proposal.md` for motivation. The repository already uses colocated Node test files and JSON fixtures beneath `core/test/fixtures/`; this change is deliberately a small qualification item with no production seam.

The issue is an engine-dogfood run, but it does not report an engine failure class. It requests a run-specific clean-docs fixture so the FRG can observe the normal lifecycle. Therefore there is no shared classifier, recovery recipe, gate, or controller defect to change, and the next identical engine fault question is not applicable unless this run exposes an actual fault.

## Goals / Non-Goals

**Goals:**

- Reuse the existing colocated test and JSON-fixture conventions.
- Bind the evidence to the exact FRG pack run and release version.
- Make release-version drift fail deterministically at runtime.

**Non-Goals:**

- Generalize FRG fixture loading or introduce a fixture registry.
- Modify a production classifier, recovery recipe, gate, controller, CLI path, or host wrapper.
- Add merge authority to advance, single, or loop.

## Decisions

### Use the exact run-scoped directory

Place the JSON file beneath `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/` and make the test resolve that literal path relative to the test module. This prevents an older or shared fixture from accidentally satisfying the run. A shared release-fixture helper was considered and rejected because one direct read is the first useful reuse rung and a helper would add an unnecessary abstraction.

### Assert the parsed value at runtime

Parse the JSON and compare `release_version` directly with the literal string `1.40.1`. A TypeScript-only shape declaration is insufficient because this repository strips types without type-checking, and it would not prove the fixture's runtime content.

### Keep lifecycle proof outside production changes

The ordinary Pipeline and FRG controller supply the ready-to-deploy and close-without-merge evidence. The fixture change does not add a second scheduler, merge path, or recovery mechanism.

## Risks / Trade-offs

- [Literal run binding makes the fixture intentionally non-reusable] → Keep both the path and assertion scoped to this pack; future packs create their own run directories.
- [A malformed JSON file can fail before the equality assertion] → Treat parse failure as a valid test failure because malformed evidence cannot prove the release version.
- [Operational lifecycle outcomes are not proven by the unit test alone] → Require the full Pipeline and FRG run evidence in addition to the repository test gate.
