## Context

See `proposal.md` for motivation. FRG template `clean-docs` expands a pack-run-scoped
fixture path under `core/test/fixtures/frg/<pack_run_id>/` and requires a unit test that
pins `release_version`. This change is intentionally minimal: test-only artifacts for pack
run `frg-1-33-0-f66627485c58a658c444ae3b` and release `1.33.0`.

Repo constraints that shape the approach:

- Edit only test/fixture surfaces; no production stage or FRG driver changes.
- Unit tests use Node's test runner (`node --test --experimental-strip-types`) under `core/`.
- Tests inject I/O via filesystem reads of fixtures only — no real network, git, or subprocess.
- `plugin/` mirror is regenerated only if `core/` non-test production sources change; this
  change targets `core/test/` only, so mirror regeneration is not expected.

## Goals / Non-Goals

**Goals:**

- Place one JSON fixture at the exact run-scoped path named by the issue.
- Provide one unit test that fails when `release_version` is not `1.33.0`.
- Keep the fixture and test path-isolated to this pack run id.

**Non-Goals:**

- Changing FRG pack templates, driver scoring, or auto-close behavior.
- Shared fixtures reused across pack runs.
- Production documentation, stages, CLI, or merge authority.
- Cross-host concurrency or OpenSpec archive behavior beyond this change's own planning artifacts.

## Decisions

### D1: Run-scoped directory only (no shared clean-docs fixture)

**Decision:** Store the fixture under
`core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-docs.json`
and hard-code that path (or an equivalent path join from that run id) in the unit test.

**Alternatives considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Run-scoped path** (chosen) | Matches FRG template contract; no cross-run collision | One directory per pack run |
| Shared `fixtures/frg/clean-docs.json` | Less nesting | Violates acceptance (run-scoped only); packs would overwrite each other |

### D2: Minimal JSON shape

**Decision:** Fixture JSON MUST include at least `"release_version": "1.33.0"`. Optional
metadata fields (e.g. `pack_run_id`, `template_id`) are allowed but not required by the
test contract.

**Rationale:** The issue acceptance only requires verifying `release_version`. Extra fields
are harmless documentation for humans inspecting the fixture.

### D3: Co-located unit test under `core/test/`

**Decision:** Add a dedicated `*.test.ts` under `core/test/` (name may include `frg` and
the run id or `clean-docs`) that reads the fixture with `fs`/`path` relative to the test
file or `core/` root and asserts equality on `release_version`.

**Alternatives considered:**

| Option | Pros | Cons |
|--------|------|------|
| **Dedicated test file** (chosen) | Clear isolation; easy FRG evidence | Extra file |
| Fold into an existing FRG test | Fewer files | Couples unrelated pack runs; harder to delete later |

## Risks / Trade-offs

- **[Risk] Fixture path typo breaks acceptance** → Mitigation: tasks checklist quotes the full path; test uses the same string literal.
- **[Risk] Test passes with wrong version if assertion is loose** → Mitigation: strict string equality to `"1.33.0"` only.
- **[Risk] Scope creep into production docs** → Mitigation: non-goals forbid production module edits; review checklist confirms diff is test/fixture only.

## Migration Plan

Not applicable. Additive test fixtures only. Rollback is delete the fixture directory and test file.
