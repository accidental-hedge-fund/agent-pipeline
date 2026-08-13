## Why

Ship-path autonomy (train∘loop, class-level recover, false-`needs-human` vs real human, deterministic recipes before LLM repair) is named in epic **#1028** and spine issues **#1020 / #1023 / #1025 / #1021**, but the factory has no durable shared memory of that intent. Operators and outer supervisors still treat every `blocked` / `needs-human` as “wait for human,” and stage prompts encode surgical minimal fix as the only global instinct — correct for product review findings, wrong when the failure is engine-owned. Without a living doctrine and a pinned harness preamble on every plan / implement / fix / intake (and related authoring) run, dogfood keeps producing site-local moles (#1013 → #1017 → #1020). This change is **memory and orientation**, not recovery implementation.

## What Changes

- Add a short canonical living doc `docs/ship-path-autonomy.md` that states the five doctrine points (ship path, recovery ladder, false vs real human, class over site, anti-goals) in operator- and agent-readable form.
- Link that doc from `docs/concepts.md` (and README advanced / supervisor index as appropriate).
- Via the single prompt seam (`core/scripts/prompts/index.ts`), inject a **versioned, pinned, short** ship-path autonomy preamble into plan, implement, fix-family, and intake/authoring prompt builders, with a stable marker for tests (e.g. `<!-- pipeline-ship-path-autonomy: v1 -->`).
- Preserve surgical-fix discipline for ordinary product review findings; the preamble **adds** factory-class judgment for engine recovery / self-host / dogfood autonomy work — it does not replace minimal-diff rules.
- Document and prompt-enforce an engine-dogfood planning / intake acceptance bar: class vs site, shared classifier/recipe/controller changes, and how the next identical fault does not need a new mole issue.
- Update `docs/supervisor.md` so `needs-human` / blocked is **not** unconditional human-wait: recoverable engine/workflow classes expect loop recovery / re-train after recipe; true human-authority waits (#647). No merge authority or second control plane for supervisors.
- Unit tests prove preamble injection on the listed builders; docs presence/link is enforced by existing docs patterns where applicable; `plugin/` mirror stays in sync; `npm run ci` green.

## Capabilities

### New Capabilities

- `ship-path-autonomy-doctrine`: Canonical living doctrine doc, pinned run-preamble injection into plan/implement/fix/intake (and related authoring) prompts, engine-dogfood class-vs-site planning bar, and supervisor outer-host alignment for recoverable vs real-human outcomes.

### Modified Capabilities

- `docs-landing-split`: `docs/concepts.md` (and related advanced index) MUST link the ship-path autonomy living doc so operators and agents share one entry point.
- `surgical-fix-rounds`: Clarify coexistence — ship-path autonomy preamble SHALL NOT remove or weaken surgical minimal-diff / destructive-guard / self-check instructions for ordinary product review findings.

## Acceptance criteria

- [ ] `docs/ship-path-autonomy.md` exists and states, in short form, all five doctrine points: ship path (train = loop over base-eligible frontiers + optional serial merge barrier), recovery ladder (classify → deterministic recipe → verify/re-review/CI → bounded model repair → real human only for human-authority classes), false human vs real human, class over site, and the listed anti-goals.
- [ ] `docs/concepts.md` contains a working relative link to `docs/ship-path-autonomy.md` (README advanced / supervisor index link when that index already points at concepts/supervisor companions).
- [ ] Built prompts from planning, planning_openspec, implementing, fix, test_fix, eval_fix (when present), visual_fix (when present), intake, refine-spec, and sweep each include the stable ship-path autonomy marker string (e.g. `<!-- pipeline-ship-path-autonomy: v1 -->`) when constructed via `prompts/index.ts` builders.
- [ ] The preamble is single-sourced (one constant or equivalent seam in `prompts/index.ts`), versioned, short (tight constitution, not the full essay), and subject to the same pin / snapshot discipline as other standing prompt blocks so mid-run template edits cannot silently drift the block for that process.
- [ ] Unit tests fail if any listed builder drops the marker or critical invariant bullets from the built prompt.
- [ ] Built fix-family prompts that include the autonomy preamble still include the surgical minimal-diff, destructive-operation guard, and pre-commit self-check instructions for ordinary review findings.
- [ ] Planning and intake/authoring prompt text (or an attached engine-dogfood instruction block) requires engine/self-host/ship-path-recover work to answer class vs site, which shared classifier/recipe/controller changes, and how the next identical fault does not require a new mole issue; spot-fix-only plans are called out as insufficient for that class.
- [ ] `docs/supervisor.md` no longer instructs unconditional “wait for human” for every `needs-human` / blocked outcome; recoverable engine/workflow classes point at loop recovery / re-train after recipe; true human-authority still waits / handoffs (#647).
- [ ] Supervisors gain no merge authority and no second control plane from this change.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change; `openspec validate pin-ship-path-autonomy-doctrine` and `npm run ci` pass when implementation lands.

## Impact

- **Docs:** new `docs/ship-path-autonomy.md`; links in `docs/concepts.md`; wording fix in `docs/supervisor.md`; optional README / advanced index cross-link.
- **Prompts:** `core/scripts/prompts/index.ts` shared preamble constant + injection into listed builders; placeholders in the corresponding `*.md` templates as needed.
- **Tests:** `core/test/prompt-loader.test.ts` (or adjacent prompt tests) for marker / invariant presence and surgical coexistence.
- **Mirror:** `plugin/` regenerated via `node scripts/build.mjs`.
- **Non-goals (no behavior change here):** recovery implementation for #1020/#1025/#1023/#1021; merge-in-loop / auto_merge; LLM-as-classifier of human vs engine; dumping CLAUDE.md/skill text into every prompt; weakening surgical fix for normal product findings.

## Related

- Documents intent of epic #1028; complements (does not block) #1020, #1025, #1023, #1021, #1029.
- Prefer landing in **v1.38.1** so the spine is remembered, not only implemented.
