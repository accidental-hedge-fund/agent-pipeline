## Why

`loop_run_stopped` with reason `dependency_deadlock` stopped the ship five times in 2026-08-10–15 on items that were **not** true hard waits (#838, #839, and related dogfood). The engine treats every `#N` under `## Dependencies` (and phrase forms that resolve out of the train selector) as a scheduling gate. Soft related-work / later-milestone / stale prose then becomes `external_depends_on` with status `pending` and fires a typed deadlock. Hermes MEMORY already works around this by moving soft refs to `## Related` — that is operator labor, not engine law. Real hard deps (e.g. #647 → #599) must keep waiting; soft or off-train references must not stop the train.

## What Changes

- **Hard-wait admission:** A lexically (or otherwise) declared prerequisite becomes a **hard wait** for loop/train scheduling only when the target is an **open issue on the same train selector** (milestone / explicit issue list / other work-list snapshot). Targets that are closed, merged, missing, or **not on this train** do not gate eligibility.
- **`ignored_dep` telemetry:** When a declared reference is not admitted as a hard wait, the engine records an `ignored_dep` (or equivalent structured log/event field) with a stable reason (`closed`, `not_on_selector`, `not_open`, etc.). Operators can audit without rewriting issue bodies mid-ship.
- **Soft prose never deadlocks:** `#N` under Related / see also / dogfood / later-milestone prose (outside hard declaration context) MUST NOT admit a deadlock. Bare refs outside phrase grammar and outside a `Dependency`/`Dependencies` section remain non-edges (existing grammar). Soft section headings (`Related`, etc.) MUST NOT be treated as dependency sections.
- **Real hard deps unchanged:** `Depends on: #B` / `blocked by #B` (and bare `#B` under `## Dependencies`) where B is **open and on this train** keep existing hold / `dependency_deadlock` behavior.
- **No body rewrite requirement:** The ship path does not require Hermes or operators to edit issue bodies to unblock soft/stale refs.
- **Not BREAKING for true in-train deps.** **Behavioral change (intentional):** open prerequisites **outside** the train selector no longer block the dependent on that train (previously `external_depends_on` + `pending` → deadlock). Cross-milestone hard sequencing requires the prerequisite on the same selector or a future explicit product feature.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `declared-dependency-grammar`: Clarify soft-section exclusion — headings such as Related / see also / dogfood / later milestone are **not** dependency sections; bare `#N` there remains non-edge. Keep phrase + `Dependency`/`Dependencies` section lexical ownership.
- `work-list-declared-dependency-population`: After raw declaration union, **admit hard waits** only for open targets on the current work-list/train selector; drop non-admitted ids from `depends_on` / `external_depends_on` gates and record `ignored_dep` with reason. Do not invent LLM ordering.
- `durable-run-dependency-integrity`: `dependency_deadlock` and external pending gates apply only to **admitted** hard waits. Ignored (off-selector / closed / soft) references MUST NOT make a frontier unrunnable solely via those refs. Real in-snapshot open deps keep deadlock semantics.

## Acceptance criteria

- [ ] Fixture: issue A body has `#B` only under Related / “see #B” / soft prose (not phrase hard-declaration, not a bare ref under `## Dependencies`) → compile/train does **not** create a hard wait on B and does **not** stop with `dependency_deadlock` for that reason.
- [ ] Fixture: issue A has `Depends on: #B` (or `blocked by #B`) and B is **open on the same train/work-list selector** → A remains gated; if the frontier is only A waiting on B, `dependency_deadlock` (or equivalent hold) behavior is unchanged.
- [ ] Fixture: issue A has `Depends on: #B` and B is **closed**, **merged**, or **open but not on this train selector** → B is **not** a hard wait; A is eligible (subject to other gates); an `ignored_dep` record names B and the reason.
- [ ] Fixture: issue A has bare `#B` under `## Dependencies` with B open off-selector (dogfood class #838/#839) → no ship-stop solely for that ref; `ignored_dep` reason is recorded.
- [ ] Fixture: real in-train pair (class of #647 → #599) still waits; no regression to “always ignore Dependencies.”
- [ ] Unit tests inject deps (no real network, git, or subprocess). After any `core/` edit, regenerate `plugin/` in the same change. `openspec validate loop-hard-deps-on-train-selector` and `npm run ci` pass when implementation lands.

## Impact

- `core/scripts/declared-dependency-grammar.ts` — soft-section non-admission clarity / fixtures.
- `core/scripts/loop/work-list-deps.ts` — hard-wait admission after discovery union; `ignored_dep` provenance.
- `core/scripts/loop/dependencies.ts` / supervisor deadlock path — only admitted hard waits gate eligibility and `dependency_deadlock`.
- Tests: `core/test/work-list-deps.test.ts`, `core/test/declared-dependency-grammar.test.ts`, deadlock fixtures in loop supervisor / dependency integrity tests.
- Generated `plugin/` mirror when `core/` changes.
- Depends on: none. Non-goals: LLM architectural ordering when `Depends on` is missing; changing #647→#599 product intent; #1068 (`pr_opened` + `ready` no-op). Program: **v1.39.1** live ship-stop class fix.
