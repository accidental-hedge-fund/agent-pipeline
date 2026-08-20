## Context

See `proposal.md` for why. This is a synthetic FRG pack item (`template_id=clean-openspec`, pack `pack-1395-tugboat-ship-1.39.5`). Current state:

- `core/test/fixtures/frg/` does not exist yet.
- `scripts/build.mjs` mirrors `core/scripts`, `core/profiles`, and core package files into `plugin/`. It does not mirror `core/test/`.
- Living spec `factory-reliability-gate` describes the real FRG driver, pack inventory, and release precondition. It is not the home for a run-scoped synthetic fixture.

## Goals / Non-Goals

**Goals:**

- Add one JSON fixture and one unit test that prove the fixture names release `1.39.5`.
- Keep the OpenSpec change exclusive to issue #1158 so pre-merge can archive it with no foreign active change.

**Non-Goals:**

- Production engine, FRG driver, pack template, Tugboat, merge, or release changes.
- Plugin mirror regeneration (no `core/scripts/` edit).
- Classifier, recipe, gate, or controller changes. This is a path exercise, not a recovery mole.

## Decisions

### 1. New capability, not a factory-reliability-gate delta

Add `frg-pack-1395-clean-openspec` as a new capability. Do not add a 1.39.5 fixture requirement to the living FRG spec.

**Why:** the living FRG spec is class law for every release. A pack-run fixture that names `1.39.5` is run-scoped. Mixing it into `factory-reliability-gate` would pollute production requirements.

**Alternative considered:** a `skip_specs` change. Rejected. The issue asks for one OpenSpec requirement, and the FRG clean-openspec path requires an archive into `openspec/specs/`.

### 2. Field name `release_version`

The fixture SHALL use `release_version` with value `"1.39.5"`. Optional identity fields `pack_run_id` and `template_id` may sit beside it so the file is self-describing.

**Why:** FRG pack provenance already uses `release_version` (templates, manifests, tests). Do not invent a second key such as `version` or `release`.

**Alternative considered:** a bare string file. Rejected. JSON is the issue contract, and a named field is testable without parsing conventions.

### 3. Disk-read unit test, no production import

The test lives at `core/test/frg-pack-1395-clean-openspec.test.ts`. It reads the fixture with `readFileSync`, parses JSON, and asserts `release_version === "1.39.5"`. No `deps` seam, no network, git, or subprocess.

**Why:** there is no production module to inject. The behavior is the fixture contents.

**Alternative considered:** inlining the expected object in the test only. Rejected. The issue requires a run-scoped JSON fixture file.

### 4. Tests stay under `core/test/` so the plugin mirror stays still

Do not edit `core/scripts/`. `npm run ci` still runs `build.mjs --check`; that check stays green without a plugin commit.

## Risks / Trade-offs

- **[Risk] Archive leaves a run-scoped living spec.** → Accept. The clean-openspec path must archive into `openspec/specs/`. The capability name includes the pack id so later packs do not collide.
- **[Risk] A later implementer changes production code "while here".** → Tasks and spec scenario forbid `core/scripts/`, `hosts/`, and `plugin/` edits.
- **[Risk] A second active OpenSpec change leaks in.** → This change is the only active directory. Pre-merge archives it. Do not author a sibling change for #1158.

## Migration Plan

- Implement on this issue branch only.
- Pre-merge archives `frg-pack-1395-clean-openspec` into living specs.
- Rollback is revert of the fixture, test, and archived spec. No production rollback is needed.
