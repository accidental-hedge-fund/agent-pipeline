## Context

See `proposal.md` for why. Current law and code:

- Non-merge train already parks a held item and continues proven-independent peers (`train_sibling_halted`).
- Merge-mode living spec already says independent ready-to-deploy siblings MAY merge while a peer is parked (`integrated-train-mode`).
- Merge-mode **code** still whole-train STOPs on the first hold. Four returns in `runTrain` log `will not implement another sibling`. A later-wave guard STOPs with `will not implement #<n> while #<h> is blocked/parked` whenever `held.size > 0`. File header calls that the anti-PR-farm rule.
- `#1063` fixtures currently require that halt (`must not implement #1073`, `must not merge a sibling after a park`). Those tests contradict the living independent-R2D merge rule and are the #1273 bug.
- `isIndependentOfHeld` checks only **direct** edges in both directions. Issue decisions require **transitive dependents** of a held item, and do not skip a held item's prerequisites.
- Work list is already resolved once (`snapshots` → `ordered`). The frozen-set rule locks that so `--milestone` cannot grow mid-run when an engine-class sibling is filed.
- JSON `train_status` has `items[]`, `complete`, and `blocker`. A STOP after the first hold omits never-started issues from `items`, so a caller must parse prose to learn they were skipped.

Locked issue decisions: in merge mode a contained hold does not abandon independent remaining work; independence is no direct or transitive path from a remaining item to a held item; dependents are `dependency-skipped`; freeze the selected set at start; merge eligible independents then exit non-zero; structured result reports completed, held, and dependency-skipped items.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is #268 on a seven-issue merge train (timeout overrun, then `waiting` / CI queue). The class is: merge-mode train treats a **contained per-item hold** as a whole-train STOP and abandons independent remaining work. The next identical fault is any contained block, park, wait, or non-ready terminal on one selected item while independents remain.
2. **Shared surfaces.** Train controller hold/frontier (the merge-mode sibling-abandonment STOPs), transitive dependent skip, frozen work list, and `train_status` / `train_sibling_halted` reporting. Not a #268-only mole. Recovery stays inside the advance wave (`recover-parked` once). Train still MUST NOT call `repair_pipeline_item`.
3. **Next identical fault.** A contained hold on any work-list item holds that item, skips its dependents, continues independents, merges eligible independents, and names every selected issue in JSON. No new mole for "waiting on CI abandoned the rest of the milestone."

Human comment vs issue body: the comment also asks that `waiting` not be classified `run_fatal` / `workflow-engine-defect`, and that runner queue time not count against `ci_timeout`. Those are different classes (`#1265` theming; CI budget). This change treats `waiting` as a **contained hold** so siblings continue even if the classifier still labels the item `run_fatal`. It does not reclassify `waiting` and does not change `ci_timeout`.

## Goals / Non-Goals

**Goals:**

- Replace merge-mode whole-train STOP-on-first-hold with per-item hold + independent continuation.
- Skip transitive dependents as `dependency-skipped`.
- Freeze the selected set at start.
- Make partial outcomes machine-readable: every selected issue in `items`, non-zero exit when anything remains held.
- Keep merge-first, serial merge, containment proof, and recover-parked-once.

**Non-Goals:**

- Reclassifying `waiting` away from `workflow-engine-defect` / `run_fatal`.
- Changing `ci_timeout` to exclude GitHub Actions queue time.
- Adding `--continue-on-block` / `--stop-on-block` (continue-on-contained-hold is the default law).
- Parallel merge or merge inside advance/loop.
- Admitting engine-class live siblings into the current train.
- A second recoverer inside `train.ts`.

## Decisions

### 1. Contained hold is per-item; anti-PR-farm is merge-first

**Choice:** Drop merge-mode whole-train STOP on a contained hold. Keep merge-first (do not implement while an earlier ready-to-deploy open mergeable PR exists) and serial merge with containment. Anti-PR-farm is that merge-first rule, not "never start a sibling after any hold."

**Why:** Train already merges each ready item before the next implement. A contained hold leaves the last proven base unchanged. Remaining independents would branch from that same base. Abandoning them is extra fail-fast that the living independent-R2D merge rule already rejected for merge waves.

**Alternatives considered:**

- `--continue-on-block` flag, default STOP → operators still lose unattended independents unless they remember the flag. Rejected by issue decisions.
- Continue only for `waiting`, still STOP on `blocked` → two moles; the class is contained hold, not one terminal name.
- Keep STOP but improve the JSON → still abandons four independent issues.

### 2. Independence is transitive dependents only

**Choice:** A remaining item is independent iff it has no direct or transitive `Depends on` path to any held item. Dependents are held as `dependency-skipped`. A reverse edge (held item depends on remaining item) does **not** skip the remaining item. Fail closed on unknown edge kind, as today. Extend the existing `isIndependentOfHeld` helper to walk the depends-on graph instead of checking only direct bidirectional edges.

**Why:** Issue decisions define independent as no path from the remaining item to a held item, and say dependents are skipped. Skipping a held item's unfinished prerequisite would strand useful work that does not depend on the failure.

**Alternatives considered:**

- Keep direct-only checks → misses A→B→C when A is held.
- Bidirectional fail-closed (today) → skips prerequisites of the held item.
- Ownership/conflict ledger as a second independence source → loop already serializes unproven overlap inside a wave; train should not invent a second ledger.

### 3. Freeze the work list at admission

**Choice:** `--issues` and `--milestone` snapshots stay the work list for the run. Do not re-list the milestone each wave. Engine-class live siblings may still be filed; they do not join this train.

**Why:** Issue decisions require a frozen set. Mid-run admission would reintroduce PR-farming of newly filed work while a peer is held.

**Alternatives considered:**

- Re-resolve `--milestone` each wave so engine-class siblings land in the current ship → conflicts with the frozen-set decision and can implement new work after a hold.
- Explicit allowlist for engine-class siblings only → a second admission path; rejected.

### 4. Additive `dependency-skipped` terminal; every selected issue in `items`

**Choice:** Add `dependency-skipped` to `TrainItemTerminal`. Require `items` to contain every selected issue. Keep `schema_version: 1`. Optional additive summary arrays are allowed if they mirror `items`; `items` remains the source of truth. Exit non-zero and `complete: false` when any item is held or dependency-skipped.

**Why:** Today's `complete: false` + `blocker` string hides skipped issues. Distinct terminals let a supervisor partition without regex. Additive terminal avoids a schema bump.

**Alternatives considered:**

- Summary-only fields without per-item rows → still silent if `items` omits never-started issues.
- Reuse `error` / `parked` for skipped dependents → caller cannot distinguish "this item failed" from "this item never ran because of a dep."

### 5. Invert the #1063 halt fixtures; keep merge-first fixtures

**Choice:** Change `#1063` tests that require `must not implement` / `must not merge` after a park so they require independent continuation and independent merge. Keep merge-first fixtures (already-R2D open PR merges before any implement of a newer sibling). Add a #1273-shaped fixture: contained hold on 268, independents 267/266 continue, transitive dependent is `dependency-skipped`.

**Why:** Those halt tests encode the bug. Merge-first is still the anti-PR-farm rule and must keep biting.

## Risks / Trade-offs

- **[Risk] Undeclared code dependency** — an independent sibling merges while a hidden dep is held → Mitigation: fail closed on declared unknown edges; operators must declare `Depends on` for code stacks (existing trade-off).
- **[Risk] Supervisors treat any non-zero train exit as "nothing else ran"** → Mitigation: `items` lists every selected issue; docs note that partial success is non-zero with populated buckets.
- **[Risk] Engine-class sibling filed mid-run misses the current ship** → Mitigation: frozen-set decision; sibling stays milestone-labeled for a later train. Do not reverse #538 papercut policy.
- **[Risk] `waiting` still labeled `run_fatal` in loop evidence** → Mitigation: train holds the item from the contained outcome, not from the theme name. Classifier theming stays #1265.
- **[Trade-off] A true uncontained merge failure still abandons remaining work** → Accepted. Poisoned or unproven base is the original fail-fast case.

## Migration Plan

1. Land biting injected tests that fail on today's merge-mode sibling-abandonment STOPs, then change `runTrain` hold/frontier behavior and independence walk.
2. Emit `dependency-skipped` items and `train_sibling_halted` in merge mode; include every selected issue in `train_status.items`.
3. Invert #1063 halt fixtures; keep merge-first and containment-failure fixtures.
4. Update the train file-header comment so anti-PR-farm points at merge-first.
5. Regenerate `plugin/` after `core/` edits. `openspec validate` and `npm run ci` green.
6. Rollback: revert the PR; remaining independents would be abandoned again.

## Open Questions

None that block specs or task breakdown. Waiting-classification and `ci_timeout` queue-time stay companion issues.
