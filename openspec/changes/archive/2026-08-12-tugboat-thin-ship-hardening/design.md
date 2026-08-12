## Context

See proposal.md — Why. #1001 already landed Tugboat under `examples/supervisor/shell/tugboat.sh` with unit guards in `core/test/tugboat.test.ts`. Living specs cover playbook train-status parse and promote-host defaults, not the Option 1 sole-path / install-parity / operator-phrase contract.

Current friction:

- Hermes skill and ship runbook still center `ship-milestone.sh` / `pipeline-ship-playbook` for Buzz ship.
- Agent-box can hold stale `~/.local/bin` copies that diverge from repo examples.
- Doctor checks promote-host for the playbook path only; Tugboat install parity is unenforced.
- Dual naming (tugboat vs pipeline-ship-playbook) risks two stage-watch/notify trees.

Constraints:

- Product vs host boundary: host composes CLI; engine owns train/merge/release/promote policy.
- Advance never merges; no `auto_merge` / ship stage expansion.
- Single-host supervisor locks remain host-local.
- FRG stays optional/advisory on the thin path (`--skip-frg` policy already used by Tugboat).

## Goals / Non-Goals

**Goals:**

- One documented, installable thin ship path for Buzz/agent-box (Tugboat).
- Observable parity between repo examples and installed binaries (doctor or install check).
- Spec + regression lock for failure detail, CI-wait-before-finish, promote-all, PR reuse, serial multi-milestone, thinness markers.
- Operator phrase and status path documented next to the skill.

**Non-Goals:**

- Replacing engine release/promote internals (except fixing proven CLI bugs).
- Deleting `pipeline-ship-playbook.sh` or `ship-milestone.sh` from the tree in this change (redirect + de-primary is enough).
- Auto-filing ship failures; MessagingPort; grant factory; Option 2 in-engine ship.

## Decisions

### 1. Spec capability name: `tugboat-thin-ship`

- **Choice:** New living capability for the Option 1 composer contract.
- **Why:** Existing `supervisor-ship-playbook` only covers train-status decode and promote-host defaults for the older playbook. Forcing Tugboat requirements into that name confuses path identity.
- **Alternative:** Expand `supervisor-ship-playbook` to mean “any chain composer” — rejected; operators already distinguish Tugboat vs playbook filenames.

### 2. Primary path = Tugboat; playbook remains alternate source

- **Choice:** Docs and Hermes map `Ship milestone vX.Y.Z` → `tugboat.sh --milestone … --detach`. Keep playbook/source scripts in-repo as alternate/legacy composition; do not dual-install as competing primaries on agent-box.
- **Why:** Matches Option 1 locked decision and issue checklist item “thin composer is the only ship path on agent-box.”
- **Alternative:** Symlink `pipeline-ship-playbook` → `tugboat` — optional install convenience later; not required for the contract.

### 3. Install parity via doctor, not a second control plane

- **Choice:** Extend doctor (or a pure helper used by doctor) to compare key installed Option 1 entrypoints under `~/.local/bin` to repo examples when those entrypoints exist. Fail closed with refresh remediation when content diverges on critical markers (promote default, failure_detail, CI wait, thinness). Skip when unused.
- **Why:** Matches #989 playbook doctor pattern; no new durable host ledger.
- **Alternative:** Only document manual `cp` — insufficient; drift caused multi-host promote misses before.

### 4. Preserve behavior in source + tests; avoid fat rewrites

- **Choice:** Prefer surgical doc/skill/doctor/test work. Edit `tugboat.sh` only if a checklist item is actually missing or broken.
- **Why:** Surgical-fix discipline; Tugboat already implements the phase chain for #1001.
- **Alternative:** Rewrite composer from playbook — out of scope.

### 5. Shared notify/stage-watch stay siblings, not second trees

- **Choice:** Tugboat continues to invoke sibling `ship-notify.sh` / `ship-stage-watch.sh` (or env overrides pointing at the same install set). Docs and install loops list one set of binaries.
- **Why:** Checklist “single stage-watch + notify install.”
- **Alternative:** In-line notify into Tugboat — rejected; keeps messenger no-op isolation.

### 6. Version rules stay as hard-won comments + tests

- **Choice:** Keep train `vX.Y.Z`, release bare `X.Y.Z`, promote bare/`--for`, `gh release view vX.Y.Z`. Regression tests already assert; extend only if gaps remain for idempotent PR title matching.
- **Why:** Invalid leading `v` on `pipeline release` is a known operator foot-gun.

## Risks / Trade-offs

- **[Risk]** Doc/skill still mention ship-milestone authorization path → operators confuse Option 1 with parked ship-auth.  
  **Mitigation:** Explicit Option 1 section: Tugboat needs `ALLOW_MERGE=1` + compose CLI; authorized `pipeline ship` remains separate/parked product surface, not Buzz primary.

- **[Risk]** Doctor false-fail on intentionally patched host binaries.  
  **Mitigation:** Check critical markers / hash-or-subset of repo file, not byte-identical entire home; remediation is reinstall from `$ROOT/examples/…`.

- **[Risk]** De-primaring playbook without deleting it leaves two working scripts.  
  **Mitigation:** Accept dual source in-repo; agent-box install + Hermes phrase only name Tugboat; doctor optional playbook check remains for hosts still using it.

- **[Risk]** Over-scoping into FRG / auto-file.  
  **Mitigation:** Spec non-goals; thin path keeps `--skip-frg` unless operator opts in outside this change.

## Migration Plan

1. Land OpenSpec + tests/docs/skill/doctor in one PR for #927.
2. On agent-box after merge: reinstall Tugboat + siblings from `examples/supervisor/shell/` into `~/.local/bin`; remove or stop using divergent primary ship binaries.
3. Run `pipeline doctor` and confirm new/updated checks pass or skip appropriately.
4. Prove on next clean `Ship milestone vX.Y.Z` (operator-driven; not required to pass unit CI alone for “done” on host path, but repo gate is `npm run ci`).

Rollback: revert PR; reinstall previous playbook binaries if needed. No durable GitHub schema migration.

## Open Questions

- None that block the spec. Optional later: whether `pipeline-ship-playbook` becomes a thin wrapper that execs Tugboat (implementation nicety, not a requirement for #927).
