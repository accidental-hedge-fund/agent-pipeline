## Context

See `proposal.md` for motivation. Factory-gate `clean-openspec` templates already name the exact fixture and test paths for this pack run. Existing Node tests under `core/test/` use `node:test` and `node:assert/strict`. Node 24 stdlib already reads and parses JSON. No production module owns this synthetic fixture.

## Goals / Non-Goals

**Goals:**

- Stop at the first holding reuse rung: a JSON file plus one Node test that uses stdlib `fs`, `JSON.parse`, `node:test`, and `node:assert/strict`.
- Keep the fixture contract to the literal `release_version` value `1.40.1`.
- Keep `tasks.md` free of controller-owned future observations.

**Non-Goals:**

- A fixture loader, helper, wrapper, or production API.
- A new dependency, schema library, or shared FRG fixture module.
- Changes to classifiers, recovery recipes, gates, controllers, or host SKILLs.
- Proving controller lifecycle in implementer tasks.

## Decisions

### 1. Reuse Node stdlib instead of a custom fixture layer

The implementer SHALL add a JSON object `{ "release_version": "1.40.1" }` at the exact fixture path and a unit test that resolves that file from the test file, reads it, parses it, and asserts `release_version === "1.40.1"`. Path resolution uses Node stdlib (`import.meta.dirname` / `node:path` / `node:url`). A strict equality assertion is the failure mode when the value changes.

Alternative considered: a shared FRG fixture helper or schema validator. Rejected because this issue needs one literal field and the reuse ladder stops at stdlib.

### 2. Keep the issue-owned OpenSpec change as the only spec destination

This change is a new capability `frg-1-40-1-0672994e898c-r2-clean-openspec`. It does not modify `factory-reliability-gate` or other living specs. Pre-merge archives into `openspec/specs/frg-1-40-1-0672994e898c-r2-clean-openspec/spec.md` only.

Alternative considered: a delta on `factory-reliability-gate`. Rejected because the issue forbids another issue's OpenSpec change and names this exact living-spec destination.

### 3. Follow the issue's focused test command

The verification command is `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-0672994e898c-r2-clean-openspec.test.ts`. The test is read-only. It SHALL NOT write observability or other host telemetry, so the isolated-observability preload is unnecessary for this file. `npm run ci` remains the full gate.

Alternative considered: wrapping the test in a new runner or requiring extra flags in `tasks.md`. Rejected because the issue names the exact command.

### 4. Separate implementer work from controller evidence in artifacts

`tasks.md` lists fixture creation, test creation, the focused test command, `openspec validate --all`, and `npm run ci`. Archive, ready-to-deploy, non-merge, and post-recording close stay in the spec scenarios only.

## Risks / Trade-offs

- [A later edit changes `release_version` without updating the test] → The test asserts the literal `1.40.1`, so that edit fails the focused test and `npm test`.
- [Implementer copies controller observations into `tasks.md`] → Archive would wait on events that cannot occur before archive. Spec scenarios and this design forbid that copy.
- [Fixture path drift] → Exact paths are the FRG contract. Do not rename, relocate, or share them with another pack run.

## Migration Plan

Additive only. Rollback is deletion of the two run-scoped files and this OpenSpec change. No production migration.
