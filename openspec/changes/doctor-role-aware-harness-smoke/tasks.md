## 1. CLI surface and doctor composition

- [ ] 1.1 Add `pipeline doctor --harness-smoke` flag wiring (CLI parse, command registry / help text documenting one cheap model call per unique configured treatment)
- [ ] 1.2 Compose smoke results with existing static doctor checks, human summary, `--json` envelope, and overall exit code (any smoke failure → non-zero)
- [ ] 1.3 Update host SKILL / generated CLI docs surfaces that describe doctor so default remains model-free and `--harness-smoke` is called out as the opt-in exception

## 2. Treatment plan and readiness phase

- [ ] 2.1 Implement unique configured treatment enumeration `{adapter, role, model, effort}` from active config + runtime registry (built-in and extension; skip unassigned)
- [ ] 2.2 Deduplicate identical coordinates; cover implementer and reviewer roles when assigned
- [ ] 2.3 For each treatment, invoke adapter-declared `runtimeSmoke` / preflight readiness first; short-circuit model spawn on readiness failure with remediation naming adapter/role

## 3. Scratch isolation and role-aware canned smoke

- [ ] 3.1 Create throwaway scratch git repo (isolated cwd); never mutate operator worktree or managed `.worktrees/` as the smoke target; best-effort cleanup
- [ ] 3.2 Implementer canned prompt: assert exit 0, trailer-bearing commit, stage-output-contract validation, telemetry parse when declared
- [ ] 3.3 Reviewer canned prompt: assert exit 0, `review.verdict@1` (or shared schema path), no repository mutation, telemetry parse when declared; do not require commits for reviewer-only adapters
- [ ] 3.4 Fail closed with no silent adapter/model fallback; remediation names the exact treatment coordinate

## 4. Deps seam, tests, mirror, and gate

- [ ] 4.1 Define injectable smoke deps seam; real implementation owns subprocess/git I/O
- [ ] 4.2 Unit tests for plan building, readiness short-circuit, implementer vs reviewer assertion branches, JSON/exit aggregation — no real network/git/subprocess
- [ ] 4.3 Drift-guard: smoke references registered stage-output-contract ids; default doctor without the flag still performs no model calls
- [ ] 4.4 Regenerate `plugin/` via `node scripts/build.mjs` when `core/` changes; run `npm run ci` green
