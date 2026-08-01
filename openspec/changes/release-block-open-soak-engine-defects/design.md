## Context

Release preparation already fails closed on a missing/failing Factory Reliability Gate (FRG)
before mutating version files (`runRelease` step 2b). FRG proves multi-item composition can pass
thresholds for the candidate version. It does **not** prove that engine defects filed from that
candidate's soak were closed or waived.

Incident class (v1.29.0 / `loop-4d2de11c6c029a2f-s1`): six open engine-defect issues existed at tag
time; a computable open-defect query would have held the tag. Label state was too dirty to trust as
sole classifier (`bug` absent; some engine work labeled `enhancement`). Post-#787, canonical stage
diagnostics and durable recovery terminal evidence are the authoritative classification inputs;
labels are an operator index and historical fallback.

Constraints:

1. Preflight must run **before** version bump / mirror regen (same fail-closed class as FRG).
2. Unit tests remain hermetic (injected `gh` / deps; no real network).
3. Golden rule #4 — no auto-merge; this gate only refuses release preparation / tag readiness.
4. Do not invent a second blocker taxonomy; reuse #787 reason codes / durable terminal outcomes and
   FRG engine-class definition where they already exist.
5. #760 / #763 may land later — design hooks for reason/disposition and discovery/candidate
   attribution without requiring those issues to ship first.

## Goals / Non-Goals

**Goals:**

- Block `pipeline release` when open engine-class soak defects are attributable to the candidate.
- Prefer typed evidence over labels; keep label hygiene so operator and historical queries work.
- Provide an audited override with PR-body evidence; forbid silent skip.
- Exclude converged intermediate recoveries from the open-defect set.

**Non-Goals:**

- Changing FRG pack composition, K/N/rate thresholds, or Layer A/B scoring.
- CI workflow changes.
- Full #760 disposition tables or #763 scoreboard metrics.
- Auto-closing soak-filed issues from the release path.
- Cross-host redesign of host-local locks.

## Decisions

### Decision 1 — Gate placement: after FRG evidence is available, before version mutation

**Choice:** Run open-soak-defect preflight immediately after a usable FRG pass is resolved (so
`loop_run_id` / `run_id` are known) and **before** package.json bumps, mirror regen, CI, ROADMAP
edit, or PR open.

**Why:** Candidate attribution needs the FRG durable loop identity when present. Mutation-free
failure matches existing FRG abort semantics (dry-run still learns early).

**Rejected:** After version bump (leaves dirty tree); only at tag-on-merge time (too late for
release PR honesty); independent of FRG (weaker candidate linkage when FRG already supplies
`loop_run_id`).

### Decision 2 — Primary classifier is typed soak evidence; labels are fallback only

**Primary (authoritative when present):**

1. Durable recovery / ledger terminal evidence for the candidate soak `loop_run_id` (or FRG
   `run_id` linkage): terminal engine-owned failures and recovery exhaustion with
   engine-class / `workflow-engine-defect` (and FRG engine-class set) disposition.
2. Canonical `pipeline/stage-diagnostic@1` reason codes projecting to engine-class (per #787).
3. Open GitHub issues that **reference** that soak identity (body/title/markers containing
   `loop_run_id` / FRG run id / discovery-channel markers when #763 lands) and are still open.
4. When #760 typed reason/disposition fields exist on issue bodies or ledger projections, use
   them to include/exclude without re-parsing prose.

**Not blocking:**

- Recoverable intermediate blockers that re-entered progress and did not remain terminal in that
  run (converged in-run).
- Product-class / human-authority holds without engine terminalization.
- Closed issues (even if they were engine-class during the soak).

**Fallback (historical / missing typed linkage):**

Open issues created after the previous release tag (or within a documented post-tag window tied to
the candidate) that carry **both** `bug` and the stable engine-class marker label
(`pipeline:engine-class`). Label absence alone MUST NOT clear a typed hit.

**Why:** Matches the recommendation upsert: labels are not the long-term classifier, but without
fallback pre-#787 history remains invisible.

**Rejected:** Labels-only query (fails the incident class when labels are wrong). Ignoring
GitHub entirely (auto-filed issues are the durable operator-facing record).

### Decision 3 — Engine-class marker label: `bug` + `pipeline:engine-class`

**Choice:** Auto-file paths that create engine-class defect issues SHALL apply:

- `pipeline:backlog` (unchanged — still not advanced)
- `bug` (GitHub conventional defect index)
- `pipeline:engine-class` (stable marker for release/operator queries)

Non-engine-class auto-files keep backlog-only (or existing non-engine labeling). No pipeline stage
labels, no assignee, no milestone, no auto-advance.

**Why:** One stable marker is queryable (`label:bug label:pipeline:engine-class`) and does not
require a proliferating label per `DurableBlockerClass` value. Typed class remains in the issue
body / ledger.

**Rejected:** Requiring exact per-class labels only (fragile for papercut clusters); replacing
`pipeline:backlog` (would risk accidental queue advance if operators use other stage labels).

### Decision 4 — Override is explicit, non-silent, and PR-audited

**Choice:** CLI flag (e.g. `--allow-open-soak-defects "<reason>"` or structured
`--override-open-soak-defects "<reason>"`) required when any blocking open defects exist. Reason
MUST be non-empty. Release PR body SHALL include a dedicated section listing waived issue numbers
and the reason. Dry-run reports what would block without writing override evidence.

**Why:** Issue forbids silent skip; release PR is the human-owned merge surface (pipeline never
merges).

**Rejected:** Config-file permanent suppress (too easy to leave on); env-var only (not audited on
PR); auto-waive closed-but-unmerged fixes (scope creep).

### Decision 5 — Doctor-grade failure surface

**Choice:** On block, exit non-zero with:

- resolved version and soak identity (`loop_run_id` / FRG `run_id` when known)
- table/list of open blocking issues (number, title, classification source: typed vs label-fallback)
- remediation: close/fix issues, re-run soak/FRG, or use the audited override with reason

Mirror tone of `pipeline doctor` / existing FRG refusal messages — actionable, not a stack dump.

### Decision 6 — Pure helper + deps seam

**Choice:** Extract discovery/classification into a pure-ish module (e.g.
`open-soak-defect-preflight.ts`) with an injected deps interface: list open issues (gh fake),
read FRG evidence / loop ledger projections (fs/ledger fakes), clock optional. `runRelease` calls
it through `ReleaseDeps` so tests inject without network.

**Why:** Matches FRG `requireFrgPass` and stage deps patterns; enables the required unit matrix
(block / clean / override / label fallback / converged non-block).

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| False block on product-class or human holds | Exclude non-engine dispositions; require terminal engine-class or typed exhaustion |
| False clear when labels wrong but issue open | Typed/candidate-linked path still blocks without labels |
| False clear when typed evidence missing for old filings | Label fallback + created-since-previous-tag window |
| Override abuse | Non-empty reason + PR body section; no silent env skip |
| Label hygiene expands auto-file surface | Still backlog-only for stage machine; extra labels are non-stage indexes |
| #760/#763 not shipped yet | Optional field consumption; primary path uses #787 + run_id linkage now |
| Dry-run vs live divergence | Same preflight in both; dry-run cannot "succeed" past open defects without override |

## Migration Plan

1. Ship label hygiene first or in the same change so new auto-files are queryable immediately.
2. Ship preflight fail-closed; document override for emergency releases.
3. Existing open engine issues without labels: still blocked if candidate-linked via body/run_id;
   operators may add labels manually for fallback visibility (optional one-time hygiene, not required
   for this change).
4. Rollback: remove preflight call and label additions; no data migration.

## Open Questions

- Exact CLI flag spelling (`--allow-open-soak-defects` vs review-style `--override`) — implementer
  should match surrounding release CLI conventions and document in `--help`.
- Whether merge-queue release-when-complete prepare path reuses the same `runRelease` preflight
  (expected yes if it calls shared `runRelease`; verify at implement).
- Whether FRG synthetic pack issues themselves can appear in the open set (should be excluded if
  closed by FRG auto-close, or non-engine product fixtures — classify by engine-class only).
