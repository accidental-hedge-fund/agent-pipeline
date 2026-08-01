## Context

Code already owns the stage inventory:

- `STAGES` in `core/scripts/types.ts` is a 16-member ordered constant ending with
  `ready-to-deploy` then the off-ramp `needs-human`.
- `TERMINAL_STAGES` is the set `{ready-to-deploy, needs-human}`.
- `core/test/state-transitions.test.ts` pins that order and both terminals.

Operator- and agent-facing surfaces lag:

| Surface | Drift today |
| --- | --- |
| Living `pipeline-state-machine` STAGES scenario | Omits `needs-human` |
| Living terminal requirement | Claims exactly `ready-to-deploy` |
| README | “15-stage” |
| `hosts/claude` + `hosts/codex` SKILL diagrams | “13-stage”; omit `plan-review`, `design-gate`, `visual-gate`, `needs-human` |
| `openspec/project.md` | “11-stage” |

This is a **docs + living-spine alignment** change. Runtime stage handlers and
the `STAGES` / `TERMINAL_STAGES` constants MUST NOT change. The product decision
is: **code is authoritative; docs and living OpenSpec re-spec to match code**
(not the reverse).

Related epics (#597 full generator, #598 docs site) may later generate more
prose from `STAGES`; this change must ship **without** waiting on them and
must leave a drift guard that those epics can absorb rather than invent a
second source of truth.

## Goals / Non-Goals

**Goals:**

- Living spine requirements match code for full `STAGES` order and terminal set.
- README, both host SKILL surfaces, and `openspec/project.md` stop under-counting
  or omitting stages operators/agents need to plan against.
- A co-located drift-guard test fails CI when any of those surfaces diverge from
  code `STAGES` / `TERMINAL_STAGES`.
- Plugin mirror regenerated so Claude installs carry the corrected skill diagram.

**Non-Goals:**

- Changing runtime stage membership, order, or handlers.
- Re-specifying full per-stage handler behavior (owned by existing capabilities).
- Full README split / docs site (#598).
- Full CLI/config/docs generator epic (#597).
- Auto-merge or any merge-path change.
- Requiring generation of all prose from `STAGES` in this PR (a drift test is
  sufficient; generation is optional polish).

## Decisions

### D1 — Code remains the sole runtime SSOT; docs are consumers

**Choice:** Keep `STAGES` / `TERMINAL_STAGES` in `core/scripts/types.ts` as the
only runtime source. Align living requirements and human-facing text to that
constant. Do **not** invent a second authored stage list for docs.

**Alternatives considered:**

- *Re-spec code to match living “terminal is only ready-to-deploy”* — rejected.
  `needs-human` is a real terminal off-ramp (ceiling / park paths); unit tests
  already pin both terminals. Changing code would break operators and existing
  status/override surfaces.
- *Dual SSOT (hand-maintained doc list + code)* without a guard — rejected; that
  is the current failure mode.

### D2 — Drift guard via co-located test (generation optional)

**Choice:** Add a `core/test/` drift-guard that:

1. Imports `STAGES` and `TERMINAL_STAGES` from `types.ts`.
2. Reads repo-root surfaces (README, host SKILL files, `openspec/project.md`,
   and the living `pipeline-state-machine` STAGES-order / terminal requirement
   text after this change’s archive — or, while the change is active, asserts
   against the delta + living file in a way that still fails if living stays
   wrong after archive).
3. Asserts membership and order: every `STAGES` name appears in the expected
   places; terminal set text names both `ready-to-deploy` and `needs-human`;
   stage-count claims (e.g. “N-stage”) equal `STAGES.length` when a count is
   present; diagrams include `plan-review`, `design-gate`, `visual-gate`,
   `needs-human`.

Prefer **assertions against code constants** over hard-coding a second expected
list in the test body (the test may `assert.deepEqual` against `[...STAGES]`
when checking living STAGES-order prose parsed into tokens).

Optional follow-on within the same issue if cheap: a small generator or
commented “generated fragment” block — **not required** if the drift test alone
keeps surfaces honest.

**Alternatives considered:**

- *Generate all diagrams from `STAGES` in this change* — deferred unless trivial;
  diagram layout is narrative (happy path vs off-ramp), not a pure list dump.
  A forced generator that misrepresents `needs-human` as a happy-path successor
  of `ready-to-deploy` would be worse than a corrected hand diagram + guard.
- *Wait for #597* — rejected; issue is standalone by design.

### D3 — How docs represent `needs-human`

**Choice:** Document `needs-human` as a **terminal off-ramp**, not as the next
happy-path stage after `ready-to-deploy`. In ordered lists that mirror the
`STAGES` constant, it MAY appear last (matching code array order). In
operator diagrams, show it as a park/stop off-ramp from review ceilings (and
similar park paths), while the happy path still ends at `ready-to-deploy`.
Stage-count language MUST count it when claiming “N-stage” if N equals
`STAGES.length`.

**Rationale:** Code places `needs-human` last in the array for enumeration and
priority; advance never “continues past” `ready-to-deploy` into it. Both are
terminals. Docs must not invent a 17th stage or imply auto-advance from
`needs-human` to deploy-ready.

### D4 — Living terminal requirement rename + full MODIFIED content

**Choice:** MODIFY the living requirement currently titled
`Terminal stage is ready-to-deploy` so that:

- `TERMINAL_STAGES` SHALL be exactly the set `{ready-to-deploy, needs-human}`.
- Reaching `ready-to-deploy` still finalizes the happy path (PR tag + summary).
- Reaching `needs-human` stops the advance loop without auto-advancing to
  deploy-ready (resume via established override/status surfaces already
  specified elsewhere).
- Never-auto-merge remains: neither terminal merges.

Prefer keeping a clear requirement name (e.g. update title to
`Terminal stages are ready-to-deploy and needs-human`) via MODIFIED content that
includes the full requirement body. If OpenSpec rename mechanics are cleaner
for the archive merge, RENAMED + MODIFIED is acceptable as long as archive
produces a single coherent living requirement.

### D5 — Host skill symmetry and plugin mirror

**Choice:** Edit both `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` with
symmetric stage inventory (same stages and off-ramp meaning; only host command
tokens differ). After Claude host edit, run `node scripts/build.mjs` and commit
`plugin/` in the same change.

### D6 — Living STAGES-order scenario must list all 16

**Choice:** Update the `STAGES order` scenario THEN list to:

`backlog`, `ready`, `planning`, `plan-review`, `implementing`, `design-gate`,
`review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `visual-gate`,
`eval-gate`, `shipcheck-gate`, `ready-to-deploy`, `needs-human`

Preserve existing relative-index AND clauses for design/visual/eval/shipcheck.
Add an AND that `needs-human` is present and is a member of `TERMINAL_STAGES`.

## Risks / Trade-offs

- **[Risk] Over-strict diagram parsing in the drift test fails on legitimate
  narrative layouts** → Mitigate: assert required stage *names* and (when
  present) numeric counts against `STAGES.length`; do not require a single
  ASCII art shape. Prefer token/substring membership over exact diagram bytes.
- **[Risk] Living-spec drift guard fails mid-change before archive** → Mitigate:
  while the change is open, either assert the delta file + living file together,
  or land living-spine updates in the same PR as the drift test so living text
  is correct before the guard enforces it. Prefer one PR that updates living
  requirements via the change archive path (pre-merge) and includes the test
  that will pass post-archive.
- **[Risk] Stage-count marketing language (“15-stage”) used in external forks**
  → Mitigate: only in-repo surfaces are in scope; no external announce required.
- **[Risk] Scope creep into #597 generator** → Mitigate: explicit non-goal; ship
  drift test + aligned text only.

## Migration Plan

1. Land OpenSpec change artifacts (this proposal/design/specs/tasks).
2. Implementation PR: update living requirement deltas (archive at pre-merge),
   fix README / host SKILL / `project.md`, add drift-guard test, regenerate
   plugin mirror, `npm run ci` green.
3. No data migration; no config key changes; no operator flag flips.
4. Rollback: revert the PR; runtime behavior unchanged either way because
   runtime was already correct.

## Open Questions

- None blocking. Optional: whether README should say “16-stage” literally or
  describe “canonical stages in `STAGES` (including the `needs-human` off-ramp)”
  without a brittle number — either is fine if the drift guard’s rules for
  counts are explicit and match the chosen wording.
