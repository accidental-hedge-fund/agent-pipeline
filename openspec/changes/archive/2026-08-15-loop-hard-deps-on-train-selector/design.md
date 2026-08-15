## Context

See `proposal.md` for motivation and dogfood evidence (#838 / #839 / soft `## Dependencies` vs real #647→#599).

Today:

1. `parseDeclaredDependencyIds` (`declared-dependency-grammar`) returns every `#N` under a `Dependency`/`Dependencies` section plus phrase forms (`Depends on`, `blocked by`, …).
2. `work-list-deps` unions lexical + native + roadmap edges and feeds them to `compileContractItems`.
3. Out-of-snapshot ids become `external_depends_on`. Open externals classify as `pending` and block eligibility; a frontier of only such items stops with `dependency_deadlock`.

That is correct for true hard deps. It is wrong for soft related-work / later-milestone / operator-removed-but-still-in-body references that remain open off the current train.

Class-over-site: fix the shared admission rule for hard waits at population time, not a path-local train mole and not an operator body-rewrite recipe.

## Goals / Non-Goals

**Goals:**

- Deterministic hard-wait admission: open **and** on current selector → hard wait; otherwise ignore + `ignored_dep`.
- Soft Related / see-also / dogfood / later-milestone bare refs never become edges or deadlock causes.
- Preserve real in-train hard dep hold/deadlock behavior.
- Unit-testable via injected discovery/observation; no mid-ship body rewrites required.

**Non-Goals:**

- LLM architectural ordering when no `Depends on` exists.
- Changing product intent of real pairs such as #647 → #599.
- #1068 and unrelated ship-path items.
- Expanding host-local locks to cross-host.
- Requiring Hermes MEMORY workarounds as the permanent fix.

## Decisions

### D1: Admit hard waits at population, not by weakening deadlock detection alone

**Decision:** After raw declaration union, filter candidates with a pure/injected admission step **before** `compileContractItems`. Non-admitted ids never land on `depends_on` / `external_depends_on`. Deadlock detection keeps its current structure over the compiled gates.

**Rationale:** Deadlock already means “structurally unrunnable on declared gates.” Fixing only the stop reason would leave items falsely ineligible. Upstream admission matches “not a wait.”

**Alternatives considered:**

- Treat all open off-selector externals as `satisfied` — lies about satisfaction; confuses telemetry.
- Only skip deadlock when the chain is soft — still blocks eligibility mid-wave.
- Require body rewrite — rejected by issue acceptance.

### D2: Selector membership = work-list snapshot ids

**Decision:** “On this train selector” means membership in the issue-id set being compiled for the run (milestone-resolved set, explicit `--issues` list, label/roadmap-slice resolution, etc.). In-snapshot membership is the admission oracle; do not re-query GitHub milestone membership separately if the snapshot already is that set.

**Rationale:** Avoids dual sources of truth; matches `compileContractItems` partition.

### D3: Open/closed observation uses the existing injectable seam

**Decision:** Admission reads open vs closed (and merged-via-PR if already available on the observe path) through the same style of injectable deps used for external verification / work-list discovery. Closed (any terminal closed class used by admission) → ignore with `closed` (or `not_open`); do not keep as pending external.

**Rationale:** Closed completed already “satisfied” external deps; ignoring is same eligibility with clearer `ignored_dep` semantics. Closed not-planned previously skipped dependents — for **off-selector** soft/stale ship-path refs, ignore+eligible is the required outcome. On-selector closed targets should also not hard-wait (they are done or cancelled); skip-propagation for abandoned in-run items remains separate.

### D4: Soft sections are grammar non-edges; Dependencies bare refs stay lexical candidates

**Decision:** Explicitly fixture soft headings (`Related`, `See also`, …) so bare `#N` there is never a raw edge. Keep bare refs under `## Dependencies` as lexical candidates so true section hard deps still work; admission drops off-selector/closed.

**Rationale:** Issue asks both soft-prose safety and Dependencies-only-when-on-train hard waits. Grammar does not need to distinguish “soft language inside Dependencies”; train membership is the durable filter without body rewrite.

### D5: `ignored_dep` shape

**Decision:** Structured record on the discovery result (and optional event) with `{ depender, target, reason }` where `reason` ∈ at least `not_on_selector` | `closed` | `not_open`. Exact export name may match existing event vocabulary if one exists; tests assert reason class stability.

**Rationale:** Auditable ship-stop forensics without mutating GitHub issues.

### D6: Intentional behavioral change for open external hard deps

**Decision:** Open prerequisites **outside** the current selector are no longer scheduling gates on that run. Cross-milestone hard sequencing requires putting the prerequisite on the same selector (or a future explicit product feature). Document as intentional ship-path law, not a bug.

**Rationale:** Matches acceptance criteria and dogfood: off-milestone open #822 must not stop the ship.

## Risks / Trade-offs

- **[Risk] Legitimate cross-milestone `Depends on: #N` stops blocking** → Mitigation: document; operators put both issues on the train or accept ignore+`ignored_dep`. Issue explicitly wants this for ship path.
- **[Risk] Closed-not-planned on-selector was previously skip-propagating via external unsatisfiable** → Mitigation: if admission drops closed targets entirely, dependents become independent rather than skipped. Prefer this for soft/stale ship-path; for true on-selector cancelled deps, independent progression is usually better than skip-cascade. Confirm with fixtures; do not reintroduce deadlock.
- **[Risk] Resume keeps old contract edges** → Existing rule: resume does not rewrite contract edges. Migration: fresh compile / new run picks up admission; document that in-flight runs with stale external pending may need restart or a one-shot recompile path only if dogfood requires it. Prefer “fresh init admits correctly”; optional follow-up if live resume is still stuck.
- **[Risk] Soft heading false negatives** → Mitigation: table-driven heading fixtures; phrase forms still parse under soft headings.

## Migration Plan

1. Land admission + grammar fixtures + tests; regenerate `plugin/` if `core/` changes.
2. Fresh train/loop runs for a milestone pick up non-deadlocking behavior immediately.
3. In-flight runs compiled before this change may still carry old `external_depends_on`; if dogfood shows stuck resume, add a narrowly scoped re-admission on resume in a follow-up — not required for acceptance if fresh compile is the supported path.
4. No GitHub label or issue body migration.

## Open Questions

- None that block specs or tasks. Resume re-admission of pre-change contracts is optional follow-up if live dogfood still hits old contracts after deploy.
