## Context

agent-pipeline stops at `pipeline:ready-to-deploy`. Human merge is already
implemented as `pipeline merge <pr>` (`merge-sub-command`): squash-merge with
mergeability, required-check, and R2D gates, never called from advance. There is
no selector-based queue that lists “everything in this milestone that is R2D and
ready to merge.”

Issue #673 is the first slice of the merge-queue cluster (673 → 674 drive →
675 conflict/CI hold → 676 optional release). This design covers **spec + dry-run
selection/order only**. Operator authority remains explicit: invoking merge-queue
(and later drive) is the merge session; silent/background merge and any
`auto_merge` config key remain forbidden.

Existing pieces to reuse, not reinvent:

| Concern | Existing surface |
|---|---|
| Per-PR merge + gates | `stages/merge.ts`, `MergeDeps` |
| Issue → open PR | `getPrForIssue` / pr-resolution |
| Milestone selector pattern | `pipeline:loop --milestone` preflight shape |
| CLI registration | `COMMAND_REGISTRY` in `command-registry.ts` |
| Host slash/keyword packaging | namespaced-command-surface + `hosts/*/commands` |

## Goals / Non-Goals

**Goals:**

- Human-invoked `pipeline merge-queue` with at least `--milestone <title|name>`
  that discovers R2D issues, resolves open PRs, inspects mergeability and
  required checks, and prints a deterministic ordered dry-run plan.
- Dry-run is default and safe: no merges, pushes, label changes, or branch
  deletes; idempotent re-runs.
- Clear separation of **merge candidates** (pass filters) vs **skipped/excluded**
  (missing PR, non-mergeable, checks not green) so operators can trust the plan.
- Unit-testable selection via injected deps (no network in unit tests).
- Spec-level guarantee that advance never invokes merge-queue; no `auto_merge`
  config key introduced.

**Non-Goals:**

- Actually merging (sequential drive — #674).
- Conflict/CI repair loops or re-gating after hold (#675).
- Release prepare when queue empty (#676).
- Dependency-aware or roadmap-priority ordering (v1 is simple deterministic
  issue-number order).
- Additional selectors beyond milestone in v1 (label/range may be noted as
  future-compatible flags but are not required for #673).
- Changing merge gates on `pipeline merge`, review policy, or CI thresholds.
- Auto-merge eligibility judge integration (that gate is about readiness
  classification, not operator queue drive).

## Decisions

### D1 — Command name and default mode

**Decision:** Keyword `merge-queue` (CLI: `pipeline merge-queue …`; host:
`pipeline:merge-queue`). **Dry-run is the default** for every invocation in this
change. Explicit `--dry-run` is accepted as an affirming no-op flag. A future
`--apply` / drive mode is reserved for #674; until then, any request that
clearly opts into mutating drive (e.g. `--apply` if parsed) SHALL fail closed
with an actionable “drive not implemented” message rather than partially
mutating.

**Alternatives considered:**

- Nested under `pipeline merge --queue`: rejected — `merge` is irreversible and
  flag-tight; mixing queue planning into merge risks flag leakage and confuses
  allowlists.
- Always require `--dry-run`: acceptable but worse UX; default dry-run matches
  operator comment (“default remains dry-run”).

### D2 — Selector v1: milestone only (required)

**Decision:** v1 requires `--milestone <title>` (milestone title string as used
by GitHub / loop selectors). Missing selector exits non-zero with usage. Other
selectors (label, range, explicit issue list) MAY be designed later; they are
not acceptance criteria for #673.

**Rationale:** Matches the operator story (“finishing a milestone”) and reuses
the mental model of `pipeline:loop --milestone`.

### D3 — Discovery pipeline (read-only)

**Decision:** Pure function-shaped core:

1. **List issues** in the repo that belong to the milestone and are open.
2. **Filter stage:** keep only issues with label `pipeline:ready-to-deploy`.
3. **Resolve PR:** for each remaining issue, call the authoritative open-PR
   resolver (`getPrForIssue` semantics). No open PR → exclude from merge
   candidates; record as skip reason `missing-pr`.
4. **Inspect PR:** `gh pr view` for `mergeable`, `mergeStateStatus`,
   `headRefOid`, base ref; required checks via the same contract as merge
   (`gh pr checks --required` / existing merge fallback when no required
   checks — mirror merge’s check policy, do not invent a looser one).
5. **Candidate filter:** merge candidates require `mergeable === "MERGEABLE"`
   and `mergeStateStatus === "CLEAN"` and required-check gate equivalent to
   merge’s pass path. Failures become skip reasons (`non-mergeable`,
   `checks-not-green`), not candidates.
6. **Order candidates** by linked **issue number ascending** (stable,
   operator-predictable). Ties impossible for distinct issues.
7. **Print plan** and exit 0 (empty candidate list is success with an empty
   plan, not an error — so dry-run stays idempotent for “nothing ready”).

**Alternatives considered:**

- PR number order: less aligned with issue-centric pipeline labeling.
- Dependency/roadmap order: valuable but out of scope; would need durable
  dependency graph loaders and acceptance expansion.

### D4 — Dry-run output contract

**Decision:** Human-readable stdout (machine JSON optional later, not required
for #673). Structure:

1. Header: selector, mode=`dry-run`, repo, timestamp optional.
2. **Candidates (ordered):** one row/block per item with at least:
   - issue number, PR number, head SHA, base branch
   - mergeability (`MERGEABLE`/`CLEAN` etc.)
   - required-check summary (e.g. all pass | list failing/pending)
   - planned next action: for this issue’s dry-run, always a non-mutating label
     such as `would-merge` (drive will later map this to `pipeline merge <pr>`)
3. **Skipped / excluded:** issue (and PR if known), reason code, short detail.
4. Footer: counts (candidates, skipped by reason); explicit line that **no
   merges were performed**.

**Mutating deps** (`ghPrMerge`, label writes, push) MUST NOT be called on the
dry-run path. Prefer a deps bag that simply omits merge, or a mode flag that
asserts merge is never invoked — unit tests prove zero merge calls.

### D5 — Dependency injection and module layout

**Decision:** New module (suggested: `core/scripts/stages/merge_queue.ts`) with
`MergeQueueDeps` covering list-issues-by-milestone, get labels / filter R2D,
`getPrForIssue`, `ghPrView`, `ghPrChecksRequired` (and check-all fallback if
shared with merge). Handler `planMergeQueue(opts, deps)` returns a structured
plan; CLI prints it. **Do not** import merge’s `mergePr` in this change’s
dry-run path. Loop-isolation test: advance stages and advance loop do not
import merge-queue symbols (same pattern as merge isolation).

### D6 — Registry and packaging

**Decision:**

- `COMMAND_REGISTRY.merge-queue` (or `mergeQueue` lookup key consistent with
  keyword `merge-queue`): `needsIssueNumber: false`, `mutatesGitHub: false` for
  dry-run-only implementation, `needsConfig: true`, `needsGhAuth: true`,
  allowlist including `milestone`, `dryRun`, `repoPath`, `base`, `profile`
  (and only those needed).
- Host packaging: add `pipeline:merge-queue` to the namespaced in-scope set;
  forward to `pipeline merge-queue …`.
- Skill one-liner: dry-run queue plan for R2D PRs; never called by advance.

### D7 — Relation to `pipeline merge` and golden rule #4

**Decision:** Document in specs:

- Dry-run does not call `mergePr`.
- Drive (#674) will call the existing merge primitive per ordered candidate;
  it will not reimplement squash/delete gates.
- No `auto_merge` config key; `auto_merge_eligibility` remains a separate
  readiness classifier and is not wired into merge-queue selection in this
  change (R2D label is the stage gate).

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Dry-run plan races real mergeability (GitHub UNKNOWN / checks flip) | Document plan as point-in-time; drive (#674) re-gates via `pipeline merge` before each squash |
| Milestone title mismatch (title vs number) | Spec title string; fail closed with clear error if milestone resolves to zero issues and milestone is unknown (prefer distinguishing unknown milestone vs empty R2D set when `gh` can tell) |
| Large milestones → many `gh` calls | Accept for v1 dry-run; inject deps so tests stay offline; pagination via existing gh helpers |
| Operators confuse dry-run with drive | Default dry-run; footer “no merges performed”; fail closed on premature `--apply` |
| Ordering too naive for dependency stacks | Explicit non-goal; document issue-number order; later change can extend without breaking dry-run contract |
| Drift from merge’s check fallback policy | Share or mirror merge’s required-check + no-required-checks fallback semantics; test parity for “all green” definition |

## Migration Plan

1. Land OpenSpec change (this PR planning slice).
2. Implement dry-run + tests + packaging; `npm run ci`.
3. Operators use `pipeline merge-queue --milestone …` before manual
   `/pipeline:merge` while #674 is open.
4. No rollback concern beyond removing the command; no schema or label
   migrations.

## Open Questions

- Exact unknown-milestone error vs empty-plan UX when the title typos (prefer
  fail closed if API can list milestones and title is absent).
- Whether stdout gains a stable `--json` plan schema in the same PR as
  implementation (nice for #674; optional if human table is enough for #673).
- Whether skipped “checks not green” items stay visible only in dry-run report
  (yes per design) or whether a future flag filters them entirely from output.
