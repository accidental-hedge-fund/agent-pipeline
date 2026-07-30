## Context

Agent-pipeline’s value is multi-item factory behavior: durable `pipeline:loop`, worktree capacity,
resume, pre-merge OpenSpec archive, implement/test gates, and evidence. Those paths are unit-tested
in isolation and lightly piloted (two-item / max_active=1 runbooks), but **release shipping** still
gates only on `npm run ci` + human release PR flow (`release-sub-command`).

Loop `loop-4d2de11c6c029a2f-s1` (v1.29.0) showed engine-class composition failures dominating
outcomes after green unit CI. Issue #723 therefore elevates multi-item reliability from optional
soak to a **mandatory Factory Reliability Gate (FRG)** on every release, with both hermetic and
live layers.

Constraints:

1. Unit tests MUST remain hermetic (no real network/git/subprocess) — Layer A uses injected seams.
2. Live multi-item runs are non-hermetic by nature — Layer B is operator/CLI-driven with immutable
   evidence, not a flaky CI job that opens PRs on every commit.
3. Golden rule #4 — no auto-merge; FRG observes and scores, it does not merge.
4. Do not invent a second ledger; reuse durable loop + evidence-bundle / scoreboard projections.
5. Reliability fixes (#712, #714, #716, #718, #722, #729, #730) are siblings; FRG must **detect**
   those classes, not re-implement the product fixes inside this change.

## Goals / Non-Goals

**Goals:**

- Make FRG mandatory and repeatable for every patch/minor/major release.
- Define a stable multi-item scenario pack with numeric, machine-checked thresholds.
- Ship Layer A (hermetic composition tests) and Layer B (live driver + evidence).
- Wire release path so missing FRG pass for the target version fails closed (or equivalent
  documented check that release automation performs).
- Classify blockers into engine-class vs product-class vs human-authority for honest gate scoring.

**Non-Goals:**

- Auto-merge or auto-tag without human release ownership.
- Replacing `npm run ci`, OpenSpec validate, or existing pilots.
- Using the full product milestone as the FRG work-list.
- Implementing the underlying reliability fixes themselves in this change (siblings own them).
- Cross-host durable-loop locking redesign (out of scope; FRG assumes single-host supported scope).

## Decisions

### Decision 1 — Two mandatory layers (A hermetic + B live), not one

| Layer | Purpose | When |
|-------|---------|------|
| **A Hermetic** | Deterministic regression for scenario *classes* via fakes | Every PR that can break them; always in release CI via `npm test` / `npm run ci` |
| **B Live** | Real gh/git/harness multi-item composition | **Every release**, before tag / release PR ready |

**Why both:** A without B ships untested harness/gh interactions. B without A is expensive and too
late as the only line of defense.

**Rejected:** Live-only soak (schedule pressure drops it; flaky as sole gate). Hermetic-only
(misses real gh/git/worktree/harness coupling that dominated v1.29.0).

### Decision 2 — Dedicated scenario pack, not product milestones

FRG selects or creates a **fixed synthetic work-list** (scratch issues / labeled fixtures) or a
known reliability milestone selector — not “whatever is open on the product milestone.” Product
milestones remain separate noise.

Minimum scenario inventory (must be named in runbook + exercised by hermetic and/or live pack):

1. Capacity under blocked retain (no false needs-human cascade) — #718  
2. Resume mid-flight → no permanent `pr_opened` dead advance — #712  
3. OpenSpec multi-change / partial archive / foreign active — #714  
4. Implement uncommitted lockfile after HEAD advances — #722  
5. Local docs/generator parity before PR — #716  
6. Clean-item throughput (≥ K ready-to-deploy without engine-class block)  
7. Blocker taxonomy scoreboard (engine-class rate ≤ threshold)  
8. Stale second PR for same issue does not remain open after new head — #729  
9. Release-cut honesty: plan-row present or scaffolded; tag path documented — #730 / #449  
10. Empty `depends_on` items that still stack OpenSpec across branches → warn/fail (process honesty)

Exact K, N, max engine-class % live in the runbook and may tighten; they MUST be numeric.

### Decision 3 — Scripted CLI entrypoint + immutable evidence bundle

Provide one operator command (name TBD at implement; candidates: `pipeline factory-gate`,
`pipeline release-check --for vX.Y.Z`) that:

1. Resolves target version  
2. Selects/creates the scenario pack work-list  
3. Starts durable loop with documented concurrency settings  
4. Writes an **immutable** evidence artifact under a stable path (e.g. under
   `.agent-pipeline/frg/<version>/<run_id>/` or documented equivalent) containing: run_id,
   version, contract hash, per-item outcomes, blocker classes, scoreboard, overall pass/fail  
5. Exits 0 only on machine-checked pass

Release integration reads that artifact (or a summary pointer) for the resolved version.

**Rejected:** “Ask an agent to freestyle a soak” as the procedure — unrepeatable and not
machine-checkable.

### Decision 4 — Blocker taxonomy for gate honesty

Scoreboard MUST bucket outcomes into at least:

- **engine-class** — capacity cascade, resume strand, archive false-pass, lock dirt with 0 attempts,
  docs-after-PR, PR supersession bugs, etc. (factory defects)  
- **product-class** — intentional scenario product failures or out-of-scope product issues  
- **human-authority** — holds that correctly require human (merge, authority, decision)

Engine-class rate above threshold **fails** the gate. Product-class holds injected by the pack do
not fail the gate unless they exceed intentional injection. This prevents “green” FRG while the
factory is still broken.

Reuse or extend factory-scoreboard / durable-blocker classification projections rather than a
parallel metrics system when possible.

### Decision 5 — Release integration: fail closed on missing FRG

Modify `release-sub-command` path so that after version resolution (and preferably before or as
part of the pre-PR readiness surface), the release process:

- Looks up an FRG pass artifact for the resolved version  
- Fails with a clear error if missing, expired (if TTL is defined), or `pass: false`  
- On success, links run_id + pass summary in release PR body or a release comment  

**Phased enforcement allowed in design:**

1. **Docs + checklist** land first if CLI automation is multi-PR  
2. **Hard refuse in `pipeline release`** is the end state  

Spec requires the hard refuse behavior; tasks may sequence docs before full automation as long as
acceptance criteria’s “enforces or documented equivalent that release checks” is met, with hard
CLI refuse as the preferred default when implementable in-scope.

**Does not** auto-tag without human merge of the release PR (existing auto-tag-on-merge still
requires a release merge; FRG is a pre-ship condition on preparing that release).

### Decision 6 — Hermetic pack structure

Layer A is co-located unit tests using existing `Deps` seams (supervisor, worktree, pre-merge,
implement/test-gate). Prefer one pack module or clearly named suite files mapping 1:1 to scenario
ids so failures name the FRG scenario. Each scenario either:

- has a biting hermetic test, or  
- documents an explicit waiver with sibling issue link (no silent gaps)

Bite checks: tests must fail when the bad behavior is reintroduced (document or structure so
review can see the assertion).

### Decision 7 — Live pack reuses durable loop, does not fork runtime

Layer B drives the shipped durable loop / `pipeline:loop` supervisor against the scenario pack.
No second ledger, lock namespace, or alternate advance engine. Evidence is derived from recorded
run state (ledger, events, summary) plus the FRG scoreboard projection.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Live FRG is slow / expensive every release | Fixed small pack + concurrency settings; not full milestone; thresholds may start modest and tighten |
| Live FRG flakes on external GitHub noise | Machine taxonomy separates engine vs human; retries documented; hermetic Layer A catches pure logic regressions |
| Gate becomes rubber stamp under pressure | Hard CLI refuse + numeric thresholds; engine-class rate fail |
| Sibling fixes land after FRG, hermetic pack red forever | Waivers with issue links allowed temporarily; FRG still requires live pass once fixes land |
| Artifact path / schema drift | Schema version field on FRG report; release check validates known schema |
| Confusing FRG with two-item pilots | Runbook states FRG supersedes pilots as **release** gate; pilots remain useful smoke |

## Migration Plan

1. Land runbook + schema + hermetic pack (CI starts failing on composition regressions).  
2. Land live driver CLI; run first FRG for the release that ships the gate (v1.29.1 target).  
3. Wire `pipeline release` refuse-on-missing-FRG.  
4. Subsequent releases (v1.30+) reuse the same driver/runbook — prove repeatability.  
5. Archive OpenSpec change at pre-merge as usual.

Rollback: remove release refuse and demote docs only if emergency (not recommended); hermetic tests
can stay as pure regression value.

## Open Questions

- Exact CLI name: `factory-gate` vs `release-check` vs subflag of `release` — implementer picks
  one and documents; specs use “FRG driver command” abstractly plus one concrete example.
- Whether FRG artifacts live under `.agent-pipeline/frg/` vs run-store subdirectory — implementer
  chooses stable path documented in runbook; release lookup must be deterministic.
- Initial numeric thresholds (K, N, max engine-class %) — set conservatively in runbook v1 and
  tighten via follow-up docs PRs without reopening the capability contract shape.
- Scratch-repo vs self-dev for Layer B — both allowed if evidence schema is identical; runbook
  should prefer one default.
