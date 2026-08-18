## Context

See `proposal.md` for why. Current law and code:

- Pin resolution (`productionPinPath`) already prefers
  `AGENT_PIPELINE_PRODUCTION_PIN` over
  `<repoDir>/.agent-pipeline/production-engine-pin.json`. Tugboat and
  the host `pipeline` launcher do **not** export that env. Promote
  therefore writes `opts.repoDir` (often a worktree). The next train
  doctor reads the factory control checkout pin. Those are different
  files. After v1.39.3, `origin/main` stayed `no-frg-1.39.1`.
- Default Tugboat argv already omits `--skip-frg` (#1039). Host Buzz
  still launched a stale installed `pipeline-ship-playbook` that
  hard-coded `--skip-frg`. Doctor already fails a legacy
  `ENGINE_PROMOTE_HOST:-codex` playbook. It does not fail a stale
  skip-frg composer.
- Default promote already refuses `no-frg-*` without skip (#1041).
  Doctor `install:engine-track` already fails a factory `no-frg-*`
  pin. The v1.39.4 failure was pin-path split, not a missing refuse
  predicate.
- FRG runbook still says `.agent-pipeline/frg/` is **not** gitignored
  and operators **must** commit `latest.json` so auto-tag sees it
  (`release-auto-tag-on-merge`). The artifact ignore contract does not
  list `frg/`. A pack write left untracked `latest.json` on the
  protected checkout and failed `worktree-clean`.
- Tugboat refuses `*factory-control*` as `REPO_DIR`. Live ship plane
  is the control checkout. Factory pin file means that checkout's
  `.agent-pipeline/production-engine-pin.json` (or an explicit env
  override). Host-only `skip-worktree` is a non-goal.

**Class vs site (engine-dogfood bar):**

| | |
| --- | --- |
| **Site** | v1.39.3 pin landed in a worktree; v1.39.4 doctor read `no-frg-1.39.1`; a human copied the pin; Buzz ran an old skip-frg playbook; leftover `latest.json` dirtied main. |
| **Class** | Factory ship promote and the next train doctor MUST share one pin path. Default ship MUST stay FRG-on. FRG runtime files MUST be ignored engine artifacts. Stale skip-frg composers MUST fail doctor. |
| **Shared surfaces** | pin-path export (`AGENT_PIPELINE_PRODUCTION_PIN`), `engine-promote` write target, doctor `install:engine-track`, artifact ignore contract, installed Tugboat/playbook doctor check. |
| **Next identical fault** | A later promote into a worktree, a later stale skip-frg binary, or a later unignored `latest.json` fails the same tests. No new mole issue. |

A path-local copy of one pin file, or `git update-index --skip-worktree`
on one host, is not the class fix.

## Goals / Non-Goals

**Goals:**

- One exported pin path for promote write and next-train doctor read.
- Default ship composers export that path when unset.
- Ignore `.agent-pipeline/frg/` so pack leftover cannot fail
  `worktree-clean`.
- Doctor / unit tests bite stale skip-frg composers and default
  `no-frg-*` writes.
- After promote of N, doctor on a clean factory control checkout
  accepts `frg-…` for N.

**Non-Goals:**

- Calling v1.39.2 FRG-done.
- Host-only `skip-worktree` as the product fix.
- A second pin schema or a second ship brain.
- Merge inside advance/loop; `auto_merge`; a merge stage.
- Removing auto-tag's need for release-eligible FRG evidence.
- Changing `isProductionQualityPin` semantics beyond path-sharing.

## Decisions

### 1. Shared pin path is `AGENT_PIPELINE_PRODUCTION_PIN`, default factory pin file

**Choice:** Tugboat and the host `pipeline` launcher SHALL export
`AGENT_PIPELINE_PRODUCTION_PIN` when unset. Default value is the
absolute factory pin:
`<factory-control-checkout>/.agent-pipeline/production-engine-pin.json`.
`engine-promote` already honors that env. Train doctor already honors
it. The missing law is that factory ship **sets** it so both sides
cannot silently use different `repoDir`s.

**Why not "always write repoDir":** that is the bug. Promote
`repoDir` is often a worktree.

**Why not "always write cwd":** cwd during promote is not the factory
pin authority (`factory-two-track-engine-pinning` already refuses
product-local pins as authority).

**Why not a new env name:** the override already exists. A second name
splits readers again.

**Factory vs product:** ordinary non-factory product repos SHALL NOT
gain a new required pin. Export applies on the factory ship / factory
control plane (Tugboat, host factory launcher). Existing
`isFactoryControlRepo` / pin-authority refuse stays.

**Tracked pin dirt:** the factory pin file remains the live authority.
This change does not gitignore `production-engine-pin.json`. If
writing that tracked file would fail the next train's
`worktree-clean`, implementation SHALL persist the pin on the exported
path without a human copy (the class is "same path", not "commit on
main by hand"). FRG leftovers are a separate ignore problem (Decision
2).

### 2. Ignore `.agent-pipeline/frg/`; do not use skip-worktree

**Choice:** Add `.agent-pipeline/frg/` to the exported artifact ignore
contract and this repo's root `.gitignore`. Pack and promote writes of
`latest.json` SHALL NOT fail `worktree-clean` on the factory control
checkout. Host-only `skip-worktree` is forbidden as the product fix.

**Conflict (named, not averaged):**

- FRG runbook + `release-auto-tag-on-merge`: auto-tag reads
  `.agent-pipeline/frg/<ver>/latest.json` from the job checkout.
  Runbook says the tree is **not** gitignored and operators **must**
  commit `latest.json`.
- This issue: the tree **is** gitignored so the next train is not
  dirty.

**Resolution:** worktree-clean on the factory control checkout wins
for ignore. Auto-tag still requires release-eligible evidence for the
version. The release path MAY `git add -f` that version's evidence
onto the **release PR** so CI/auto-tag sees it. That force-add is
release-branch attachment (already allowed by "FRG evidence SHALL be
attachable to the release PR"). It is not a reason to leave `frg/`
unignored on the factory control checkout. Local `latest.json` remains
the ship-host lookup for `pipeline release` / `engine-promote` on the
same host that just packed.

If previously committed `frg/` files would still show as modified
tracked dirt, implementation SHALL untrack them or otherwise prevent
that class of dirt. Gitignore does not hide modifications to tracked
files.

### 3. Doctor the installed composer for stale skip-frg, same class as host-default

**Choice:** Extend the existing installed-composer doctor class
(`supervisor:ship-playbook-promote-host` and Tugboat pack-parity).
When an installed Tugboat or `pipeline-ship-playbook` still hard-codes
default `--skip-frg` on release or promote, doctor SHALL fail closed
with refresh remediation. Absence of an installed composer still
skips. Repo example sources already omit default `--skip-frg`; this
check catches the **installed** stale binary Buzz actually launched.

**Why not "only document Tugboat":** docs already say Tugboat is
primary. The host still ran the old playbook. Doctor must fail that
class.

**Why not delete the playbook:** out of scope. Alternate path may
remain. It must not hard-code skip.

### 4. Keep `isProductionQualityPin`; add a bite for default `no-frg-*` write and the next-train doctor pass

**Choice:** Reuse `isProductionQualityPin`. Add or tighten a
hermetic test that fails if default promote would write `no-frg-*`
without explicit skip (already required by #1041; this change keeps
that bite). Add a hermetic doctor/pin-path test: after a non-skip
promote into the exported factory path, factory `install:engine-track`
accepts `frg-…` for N even when a worktree `repoDir` also has a
different pin file.

**Why not a new predicate:** one exported quality check already
exists. A second one drifts.

## Risks / Trade-offs

- **[Risk] Auto-tag checkout lacks `latest.json` if release stops
  force-adding.** → Mitigation: do not remove release's version-scoped
  FRG attach. Spec keeps auto-tag eligibility. Ignore is for the
  control checkout working tree.
- **[Risk] Exporting the pin on a product repo invents factory
  authority.** → Mitigation: export is factory ship / factory control
  launcher only. Existing pin-authority refuse stays.
- **[Risk] Writing the tracked factory pin dirties `worktree-clean`.**
  → Mitigation: pin path sharing is the class. If a tracked pin write
  fails the next train, persist without a human copy. Do not ignore
  the pin file.
- **[Risk] Stale Buzz still calls `pipeline-ship-playbook` after
  doctor is green on a host without that binary.** → Mitigation:
  doctor fails when the installed composer is present and stale.
  Hermes skill already maps ship to Tugboat.

## Migration Plan

1. Land ignore-contract + `.gitignore` + untrack leftover `frg/` if
   needed so the next train is not dirty.
2. Export `AGENT_PIPELINE_PRODUCTION_PIN` from Tugboat and the host
   factory launcher.
3. Confirm promote writes that path; doctor reads it.
4. Add doctor check for installed skip-frg composers.
5. Keep / add hermetic tests for default `no-frg-*` refuse and
   next-train pin accept.
6. Update FRG runbook commit bar so it no longer requires unignored
   `frg/` on the protected checkout.
7. Rollback: revert the change. Operators can still set
   `AGENT_PIPELINE_PRODUCTION_PIN` by hand. That is not the product
   default.

## Open Questions

None. The auto-tag vs gitignore conflict is resolved in Decision 2.
The factory vs product export scope is resolved in Decision 1.
