## Context

See `proposal.md` for why. This is a synthetic clean-path observation for pack run `frg-1.40.1-0672994e898c-r2`. Exact paths are already named by the rendered FRG template and `exactCandidateFrgOpenSpecChangeId`. Existing `core/test/` files already use `node:test`, `node:assert/strict`, `node:fs`, and `JSON.parse`.

## Goals / Non-Goals

**Goals:**

- Stop at the first holding reuse rung: a JSON file plus a Node test that reads it.
- Keep implementer work finishable before pre-merge archive.
- Keep controller lifecycle evidence in specs, not in `tasks.md`.

**Non-Goals:**

- A helper, schema module, fixture loader, or new production API.
- Isolated-observability preload (this test does not write host telemetry).
- Classifier, recovery recipe, gate, or controller changes.
- Merge, deploy, or hand-edited lifecycle labels.

## Decisions

### D1: Reuse node:test and stdlib JSON read

**Decision:** The implementer writes one JSON object and one `node:test` file. The test uses `readFileSync` from `node:fs`, `JSON.parse`, and `assert.equal` / `assert.strictEqual` from `node:assert/strict`. Resolve the fixture path from `import.meta.url` the same way other `core/test/` files resolve sibling files.

**Why:** First holding rung. The codebase already does this. The issue asks for a unit test that reads one fixture and asserts one literal.

**Alternatives considered:**

- A shared FRG fixture helper → rejected. One field, one file, one assertion.
- Importing production FRG modules to validate the fixture → rejected. That would touch production seams and is out of scope.

### D2: Keep the template-rendered filenames exactly

**Decision:** Use `core/test/frg-frg-1.40.1-0672994e898c-r2-clean-docs.test.ts` even though the `frg-` prefix repeats. Use OpenSpec change id `frg-1-40-1-0672994e898c-r2-clean-docs`. Fixture JSON requires `release_version` exactly `1.40.1` and no extra schema.

**Why:** Exact-candidate FRG path-harmlessness allows only those run-scoped names. Renaming to drop a prefix would fail the controller path proof.

**Alternatives considered:**

- Shorten the test filename to `frg-1.40.1-...` → rejected. The template is `frg-{{pack_run_id}}-clean-docs.test.ts` and `pack_run_id` already starts with `frg-`.
- Add extra identity fields to the JSON → rejected. The issue requires the release value, not a new schema.

### D3: Split implementer tasks from controller evidence

**Decision:** `tasks.md` lists only fixture creation, the unit test, the named `node --test` command, and `npm run ci`. Controller lifecycle stays in this design's specs and in `proposal.md` acceptance criteria.

**Why:** The fixture contract forbids copying future FRG observations into `tasks.md` or checking them before they occur. Pre-merge archive would otherwise wait on work the implementer cannot finish.

**Alternatives considered:**

- Check ready-to-deploy and FRG close in `tasks.md` → rejected. Those events happen after implementation.
- Skip the OpenSpec change because clean-docs OpenSpec is optional → rejected. This run is already in OpenSpec planning, and the exact-pair living spec destination is named.

## Risks / Trade-offs

- [Double `frg-` test filename looks like a typo] → Keep the rendered path. Do not rename.
- [Implementer copies controller bullets into `tasks.md`] → Keep `tasks.md` to the four implementer steps below.
- [Implementer edits production code while adding a "small" helper] → Spec forbids production files. Reuse stdlib only.
