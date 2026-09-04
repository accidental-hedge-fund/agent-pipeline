## Context

See `proposal.md` for why.

Current state:

- `core/test/fixtures/frg/` does not exist on this branch.
- FRG pack template `clean-openspec` already names the fixture path `core/test/fixtures/frg/{{pack_run_id}}/clean-openspec.json` and the release field `{{release_version}}`.
- Co-located tests already read JSON from disk with `fs.readFileSync`, `JSON.parse`, and `fileURLToPath(new URL(..., import.meta.url))` (`core/test/js-yaml-advisory-floor.test.ts`, `core/test/version.test.ts`).
- Unit tests inject I/O for engine logic. This item has no engine logic. The test reads a frozen fixture file.

## Goals / Non-Goals

**Goals:**

- Stop at the first holding reuse rung: existing Node `fs` JSON read in `core/test/`. Do not add a loader, helper, or production API.
- Pin one JSON object at the pack-run path with `release_version: "1.40.1"`.
- Prove that pin with one `node:test` file that fails if the value changes.

**Non-Goals:**

- Production code, FRG scorer, pack manifest, or ship/merge edits.
- A shared fixture schema or loader for later pack runs.
- Extra required JSON fields beyond `release_version`.
- A second active OpenSpec change.

## Decisions

### D1 — Required JSON field is `release_version`

The fixture SHALL be a JSON object whose `release_version` is the string `1.40.1`. That is the field the pack template and issue name.

Do not require `pack_run_id` or `template_id` in the object. The directory and file name already carry that identity. Extra fields MAY exist. The test asserts only `release_version`.

Alternative considered: a richer FRG evidence-shaped object. Rejected as unrequested schema.

### D2 — Read the fixture with the existing test I/O pattern

The unit test resolves `fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` from `import.meta.url` (test file lives in `core/test/`), then `fs.readFileSync` + `JSON.parse`.

Do not add a fixture helper. Do not use live GitHub, git, or subprocess. Do not inject a fake `readFile` unless a later review requires it: the file is the contract.

Alternative considered: inline the expected object in the test and skip the file. Rejected: the issue requires a fixture at that path.

### D3 — New co-located test file, not the large FRG suite

Add `core/test/frg-pack-1401-clean-openspec.test.ts`. Do not append this pack-instance pin to `factory-reliability-gate.test.ts`. That suite scores FRG evidence. This pin is unrelated production-scoring logic.

Reuse is the I/O pattern, not the FRG scorer test file.

### D4 — No production modules

Do not edit `core/scripts/`. After test-only files land, `node scripts/build.mjs --check` still applies if any later `core/` edit appears. The intended diff is fixture + test + this OpenSpec change.

## Risks / Trade-offs

- **[Risk] Archive leaves a living spec that pins release `1.40.1`.** → Accept. That pin is the synthetic pack proof. Later pack runs use a new `pack_run_id` path and their own change. This spec does not constrain them.
- **[Risk] A future edit changes the fixture version without failing CI.** → Mitigation: the unit test asserts the exact string `1.40.1` from that path.
- **[Risk] Accidental production edits while implementing.** → Mitigation: tasks forbid `core/scripts/` changes and require `git diff` to confirm.
