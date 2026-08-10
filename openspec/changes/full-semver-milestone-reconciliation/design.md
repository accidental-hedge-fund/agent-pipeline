## Context

See proposal.md for motivation.

Today SemVer `pipeline roadmap --apply` calls `applyMilestones`, which:

1. Lists existing milestones by title
2. Creates a milestone when the title is missing
3. Assigns each listed issue to that title
4. Does **not** clear stale assignments, rename, reopen, update descriptions,
   protect shipped history, fingerprint live state, or prove full open-backlog
   coverage

#909 established label-only applied compatibility impact (`semver:major` /
`semver:minor` / `semver:patch`) and excluded unresolved issues from automatic
lane placement. Full reconciliation must keep that authority while expanding
GitHub write-back into a reviewed-manifest convergence loop under
`release_model: semver` (and default/absent). Continuous mode stays on its
existing create/reuse/assign path.

## Goals / Non-Goals

**Goals:**

- Dry-run-first action plan that lists every mutation class before write-back.
- Apply converges live GitHub open-issue milestones to one reviewed manifest.
- Live-state fingerprint drift after preview blocks apply (or forces a new
  preview).
- Safe reuse of closed empty unshipped planning milestones; never rewrite closed
  shipped milestones.
- Idempotent apply and crash-safe partial-failure resume without duplicate
  milestones or repeated assignments.
- Theme/epic labels remain non-authoritative for the release-milestone invariant.
- Injected-seam tests for all acceptance collision/drift/resume cases.

**Non-Goals:**

- Deleting milestones or rewriting shipped release history.
- Inferring SemVer impact from free-form prose (owned by #909; unchanged).
- Capacity-packing unrelated issues without the existing dependency/theme plan.
- Applying this full-reconciliation contract under `release_model: continuous`.
- Auto-merge or any merge-stage authority change.

## Decisions

### Decision 1: Reviewed reconciliation manifest is the sole apply target

**Choice:** Under SemVer, roadmap dry-run and apply share one **reconciliation
manifest** derived from the plan. The manifest records:

- target milestones (stable identity when known, target title, description,
  version_impact, issue set)
- ordered **actions** (create | reuse | reopen | rename | update_description |
  assign | clear_stale)
- **manifest identity** (content hash of the full reviewed package: targets,
  ordered actions, coverage blockers, and live-state fingerprint — so action
  injection cannot preserve a valid identity)
- **live-state fingerprint** captured at preview time
- optional **progress** (completed/pending action ids) for resume

Apply mutates GitHub only by executing that action list. It does not invent
extra assignments at apply time.

**Rationale:** Matches “applied GitHub state must match one reviewed manifest”
and makes dry-run ↔ apply a pure diff/execute pipeline.

**Alternatives considered:**

- Keep assign-only apply and add a separate command → rejected; issue scopes
  `pipeline roadmap` dry-run/`--apply` and operators already review that surface.
- Mutate ad hoc during apply without a stored action list → rejected; breaks
  drift gating, resume, and exact no-op proof.

### Decision 2: Full open-issue coverage with #909 classification as a gate

**Choice:** Successful full-reconciliation **apply** requires:

1. Every **open** issue in the repository scope appears in the reviewed
   manifest with **exactly one** full SemVer milestone title
   (`v<MAJOR>.<MINOR>.<PATCH>`).
2. Every such assignment’s version selection is consistent with **resolved**
   applied impact from exclusive `semver:*` labels (#909). Free-form prose
   never chooses the version.
3. Any open issue with **unresolved** applied impact (missing or conflicting
   `semver:*`) is a **coverage blocker**: dry-run lists it; apply **refuses**
   until classification is resolved or the operator regenerates a valid
   manifest after labels are fixed.

Dependency-blocked or externally-awaiting status does **not** exempt an open
issue from the milestoned invariant under full reconciliation (planning still
targets a release). Theme/epic labels never count as a release milestone.

**Rationale:** Satisfies “no open issue remains unmilestoned” without reopening
prose-based versioning. #909 remains the authority for *which* version; full
recon is the authority for *GitHub convergence*.

**Alternatives considered:**

- Leave unresolved issues unmilestoned forever → rejects AC “no open issue
  remains unmilestoned.”
- Place unresolved issues into a non-SemVer bucket → rejects “full SemVer
  milestone.”
- Infer version from prose when labels missing → non-goal / conflicts with #909.

**Note on living lane rule:** Prior requirements that omit unresolved (and
optionally dependency-blocked) issues from *automatic lane construction* still
hold for plan generation of version bumps. Full reconciliation **apply** is
stricter: it will not succeed until every open issue is both classified and
manifested. Dry-run always surfaces the gap list.

### Decision 3: Action vocabulary and identity rules

**Choice:** Reconciliation supports exactly these action kinds:

| Kind | Meaning |
|------|---------|
| `create` | Create a new open milestone with target title/description |
| `reuse` | Bind target identity to an existing open milestone (same approved identity) |
| `reopen` | Reopen a closed empty unshipped planning milestone named by the manifest |
| `rename` | Change title of a reusable non-shipped milestone to the manifest title |
| `update_description` | Set description to the manifest description |
| `assign` | Set an issue’s milestone to the target |
| `clear_stale` | Remove an open issue’s milestone assignment when it is not the manifest target |

**Identity:** Prefer stable GitHub milestone **number** when the manifest names
it. Title match alone is allowed only when it uniquely identifies a reusable
non-shipped milestone. Ambiguous title collisions are **visible failures** (no
silent pick).

**Shipped protection:** A closed milestone that is shipped (associated with a
released/shipped SemVer identity or otherwise classified shipped by the engine’s
existing release/tag observation) is **immutable**: no rename, reopen, or
description rewrite. Issues already closed under shipped history are out of
scope for open-issue recon.

**Reusable closed:** A closed milestone may be `reopen`ed only when **all** hold:

- the reviewed manifest names its identity
- it is empty of open issues (or its open-issue set is exactly the manifest’s
  intended set after planned assigns — prefer empty for safety)
- it is not shipped

**Rationale:** Covers AC create/reuse/reopen/rename/description/assign/stale
without milestone deletion.

### Decision 4: Dry-run lists every action; apply is gated by fingerprint

**Choice:**

1. Default `pipeline roadmap` (dry-run) builds the manifest and prints **every**
   planned action with enough detail to review (kind, milestone identity/title,
   issue numbers, before→after where relevant). No GitHub mutation.
2. Preview captures `live_state_fingerprint` over open issues (number, state,
   current milestone number/title, updatedAt) and milestone catalog entries
   relevant to recon (number, title, state, description hash, open-issue count).
3. `--apply` reloads the reviewed manifest (same identity), recomputes a **fresh**
   fingerprint, and proceeds only if it matches the preview fingerprint **or**
   an explicit re-preview path regenerates the manifest. On mismatch: stop apply,
   report drift, require a new dry-run/preview. No partial mutations on drift
   failure before the first action.
4. After a successful full apply, a second apply against unchanged live state
   yields an empty action list (or only no-op reports) — exact idempotence.

**Rationale:** Drift gate prevents applying a stale plan after concurrent
label/milestone edits.

**Alternatives considered:**

- Apply without fingerprint → rejected; AC requires drift stop.
- Soft-merge drift by recomputing actions on the fly → rejected; “exact reviewed
  manifest” would no longer hold.

### Decision 5: Partial failure progress ledger and resume

**Choice:** During apply, persist a small progress record next to the plan
artifacts (or in the existing roadmap output directory) containing:

- manifest identity
- fingerprint at apply start
- ordered action ids
- completed action ids with results (e.g. created milestone number)
- next pending action id
- terminal status (`in_progress` | `failed` | `complete`)

On retry/resume with the **same** manifest identity:

- skip completed actions
- continue from the first pending action
- never create a second milestone for a create already completed
- never re-assign an issue already at the target milestone
- if live fingerprint no longer matches apply-start fingerprint in a way that
  invalidates pending actions, abort and require a new preview (same as Decision 4)

**Rationale:** Safe resume without duplicates.

### Decision 6: Continuous mode and secondary theme labels

**Choice:** Full SemVer reconciliation requirements apply only when
`release_model` is `semver` or absent. Under `continuous`, existing
theme/epic grouping and create/reuse/assign behavior remain; SemVer full-coverage
invariant, reopen/rename/stale-clear expansion, and fingerprint gate for this
change are **not** required of continuous apply in this change (may share
low-level helpers later, but not the SemVer contract).

Theme/epic labels remain searchable secondary metadata on issues and never
replace a SemVer milestone for the open-issue invariant.

### Decision 7: Test seams

**Choice:** Extend writeback/apply deps with injected GitHub seams for:

- list milestones (number, title, state, description, open issue counts)
- create / reopen / rename / update description
- get/set/clear issue milestone
- optional list open issues snapshot for fingerprint

Unit tests inject fakes only — no real network/git. Cover: title collisions,
stale clear, issue-state drift, changed manifest identity, closed shipped
immutable, reusable unshipped reopen, partial apply + resume, exact no-op
convergence.

## Risks / Trade-offs

- **[Risk] Unclassified open backlog blocks apply** → Mitigation: dry-run lists
  every unresolved issue with #909 remediation guidance; no silent defaults.
- **[Risk] Title-only matching creates wrong milestone binding** → Mitigation:
  prefer milestone number identity; fail on ambiguous titles.
- **[Risk] Concurrent operators edit milestones during apply** → Mitigation:
  fingerprint at apply start; abort on drift; progress ledger for resume after
  re-preview when needed.
- **[Risk] Reopen of non-empty closed milestones surprises operators** →
  Mitigation: only closed empty unshipped identities named by the manifest.
- **[Risk] Scope creep into continuous or delete APIs** → Mitigation: explicit
  non-goals; continuous path left on prior requirements.

## Migration Plan

1. Land types + action planner + dry-run listing behind the existing
   `pipeline roadmap` / `--apply` entry points for SemVer.
2. Expand `applyMilestones` (or successor) to execute the action list with
   progress ledger; keep create/reuse/assign as subsets of the vocabulary.
3. Update docs (CLI/config) describing full recon, fingerprint drift, and
   classification gate.
4. Regenerate `plugin/` via `node scripts/build.mjs` when core changes.
5. No data migration of historical milestones; first successful apply converges
   forward only. Rollback is “do not apply” / restore from GitHub history —
   engine does not delete milestones.

## Open Questions

- None that block specs or tasks. Shipped-detection can reuse the engine’s
  existing latest-tag / release observation already used for SemVer lane
  versioning; if a milestone is closed and matches a shipped tag title, treat it
  as shipped.
