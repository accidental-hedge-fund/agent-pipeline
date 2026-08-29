## Context

See `proposal.md` for motivation. Issue #1290 is a factory-gate `clean-docs`
template instance. The issue body names the exact fixture path and the pinned
`release_version`. This is a synthetic pack item, not an engine recover or
ship-path fault.

## Goals / Non-Goals

**Goals:**

- Land the exact run-scoped fixture and a hermetic pinning test.
- Keep the change small enough that the pipeline can reach
  `pipeline:ready-to-deploy` without engine-class friction.

**Non-Goals:**

- Changing FRG driver, evidence schema, thresholds, or release preflight.
- Product features, refactors, or `plugin/` regeneration (no production
  `core/scripts/` edits).
- Re-implementing FRG auto-close or adding a merge path.
- Claiming this single item is a release-eligible FRG pack by itself.

## Decisions

### D1 — Use the issue-named fixture path, not a docs alternative

**Choice:** Create
`core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/clean-docs.json` with
at least `{ "release_version": "1.39.15" }`. Optional provenance keys
(`pack_run_id`, `template_id`) are allowed. They are not required.

**Rationale:** The issue mandates that path and field. Earlier pack items
sometimes used a docs note; this template does not.

**Alternatives considered:**

- One-line runbook note — smaller, but it fails the named path and test-bite
  acceptance.
- Shared non-run-scoped fixture — collides with other pack runs.

### D2 — One co-located hermetic unit test

**Choice:** Add one `core/test/*.test.ts` file (suggested name
`frg-pack-13915-clean-docs.test.ts`). The test reads the JSON with `node:fs`,
parses it, and asserts `release_version === "1.39.15"`. No `deps` seam. No
network, git, or subprocess.

**Rationale:** The suite already uses `node:test` plus `node:fs` for static
file pins. A deps fake is unnecessary for a local JSON read.

**Alternatives considered:**

- Fold into `factory-reliability-gate.test.ts` — mixes pack-instance
  provenance with driver tests.
- Assert by importing production code — there is no production reader for this
  fixture, and adding one would be a production change.

### D3 — OpenSpec delta is ADDED only

**Choice:** Delta under `factory-reliability-gate` uses **ADDED** requirements
for this pack instance. Do not **MODIFY** existing FRG scoring requirements.

**Rationale:** Archive must not drop scoring detail. Auto-close without merge
already exists in the living spec.

### D4 — No production mirror regeneration

**Choice:** Implementation touches the fixture, the test, and this OpenSpec
folder. Do not run `node scripts/build.mjs` unless a mirrored production path
is edited (it should not be).

**Rationale:** Synthetic pack items must stay low-friction for clean
ready-to-deploy.

## Risks / Trade-offs

- **[Risk] Reviewer expands scope into FRG scoring or product docs** →
  Mitigation: proposal and tasks forbid scoring and production edits. Defer
  out-of-scope findings to a follow-up issue.
- **[Risk] Test does not bite** → Mitigation: during implementation, mutate
  `release_version` and confirm the test fails, then restore `1.39.15`.
- **[Risk] Living spec gains a pack-run-specific ADDED requirement** →
  Mitigation: FRG may close without merge, so archive may never reach `main`.
  The requirement names the template class (`clean-docs` + run-scoped pin)
  so the next identical instance does not need a new driver mole.
- **[Risk] Misreading this item as release-eligible FRG alone** → Mitigation:
  design and proposal state this item is clean throughput volume only.

## Migration Plan

Not applicable. Additive fixture and test. Rollback is revert of those files
and this OpenSpec change.

## Open Questions

None. The issue names the path, field, and version.
