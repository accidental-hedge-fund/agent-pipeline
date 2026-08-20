## Context

See `proposal.md` for why. Current law and code:

- Tugboat pins `PIPELINE="${PIPELINE:-pipeline}"` at process start (`examples/supervisor/shell/tugboat.sh`). Every phase, including FRG pack, `pipeline release`, and `release finish`, uses that binary. Factory ship sets it to `~/.local/bin/pipeline`, which is the last promoted pin.
- Living `tugboat-thin-ship` says the composer uses "the installed Pipeline CLI" for the whole sequence. Living `release-sub-command` says wrappers **MAY** invoke `factory-release prepare` from the exact integrated candidate when the pin is one release behind. Tugboat does not take that MAY.
- Living `factory-two-track-engine-pinning` reserves the candidate track for FRG Layer B and eval soaks, and forbids silently running the candidate as pinned production. That is a different use than ship-end publishing.
- Option 1 pack parity (`tugboat-install-parity.ts`) compares installed Tugboat to local repo examples. It does not bind the candidate SHA being released. It does not check engine source SHA. 1.39.4 promote did not refresh `~/.local/bin/pipeline-ship-playbook`.
- Tugboat already binds `integrated_candidate.git_sha` to the remote integration tip, not local `HEAD`. Local `REPO_DIR` often stays at the pre-train SHA. Candidate **code** and candidate **SHA** are therefore distinct from cwd.
- `pipeline-ship-playbook.sh` is a second compose implementation. Digest-equality against `tugboat.sh` cannot hold while that file remains a fork. This change collapses the installed playbook to a thin launcher.

**Conflict (do not average):** "use the installed Pipeline CLI for every phase" contradicts "MAY invoke prepare from the candidate when the pin is behind" and contradicts this issue. This change **supersedes** the installed-CLI rule for post-train FRG / release / finish / tag. Train stays on the pin. Two-track pinning is not averaged: ship-end is a documented candidate-track publishing use, not a silent dogfood reclassification.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is 1.39.5 Tugboat invoking `PIPELINE=…/pipeline` version 1.39.4 for release, plus a stale playbook digest. The class is: any ship-end composer that scores or publishes the candidate while still executing the previous production-pin CLI.
2. **Shared surfaces.** Candidate-engine resolution after train-complete; ship-end identity gate (exact source SHA, not version alone; playbook launcher vs stale fork). Law lives in `ship-end-candidate-engine`, adopted by `tugboat-thin-ship`, `supervisor-ship-playbook`, `ship-coordinator`, `release-sub-command`, and `factory-two-track-engine-pinning`.
3. **Next identical fault.** The next pin-behind-candidate ship runs ship-end on the candidate engine. Tests fail if FRG/release/finish/tag still use process-start `$PIPELINE` when pin SHA ≠ candidate. No new mole issue.

## Goals / Non-Goals

**Goals:**

- After train-complete, ship-end verbs execute candidate engine code at the FRG-bound SHA.
- Installed `pipeline-ship-playbook` is a thin launcher to `$REPO_DIR/examples/supervisor/shell/tugboat.sh`. Doctor validates that resolved script plus the candidate engine.
- A hermetic check fails on pin SHA / stale-playbook mismatch when those tools are used for ship-end.
- Keep Tugboat a thin composer of existing CLI verbs. Keep train on the production pin.

**Non-Goals:**

- Running implementer/review harnesses on the unpromoted candidate for train items.
- `--skip-frg` as the ship path.
- Auto-promoting before GitHub Release.
- Changing FRG attestor isolation, pack-done, or two-track pin write rules.
- Making `engine-promote` switch engines in this change (promote consumes a published tag; it is not in the issue ship-end set).
- Checking out or force-resetting operator `REPO_DIR` `HEAD` as the only resolution path.
- Deduplicating Tugboat's inlined FRG helpers vs `frg-pack-helpers.sh` beyond candidate-CLI rebinding.

## Decisions

### 1. Switch after train-complete, not at process start

Train `--merge` stays on process-start `$PIPELINE` (production pin). After train is complete or resumed complete, the composer resolves the candidate engine and uses it for the ship-end inventory in Decision 6. Promote stays on process-start `$PIPELINE`.

**Why not switch `$PIPELINE` at Tugboat start:** the candidate SHA is not known until after train merges through GitHub. Switching early would run train on unpromoted engine, which is an explicit non-goal.

**Alternative considered:** run the entire ship, including train, from a floating `main` checkout. Rejected: two-track pinning and the issue non-goals require train on the pin.

### 2. Candidate-resolution contract (one, closed)

**Source of `integrated_candidate.git_sha`:**

| Composer | SHA source after train-complete |
| --- | --- |
| Tugboat | The 40-hex `integrated_candidate.git_sha` already written into `$RUN_DIR/factory-release-prepare-request.json` (remote `origin/<base_branch>` tip, or injected `TUGBOAT_CANDIDATE_SHA` in tests). Same binding Tugboat already uses today (`tugboat.sh` request writer). |
| In-engine `pipeline ship` | `ShipTrainEvidence.integrated_head_oid` already persisted on ship status (same 40-hex OID `ship-adapter.ts` `requireOid` accepts). |

Do not re-parse train stdout as a shell fragment. Read the SHA from the JSON field with a parser (Python/`JSON.parse`). Reject anything that does not match `^[0-9a-f]{40}$` after lowercase. Abbreviated SHAs fail closed. The existing `factory-release-prepare.ts` `GIT_SHA_RE` / `requireOid` stay the request validators.

**Allowed engine roots (first match wins):**

1. `REPO_DIR` when `git -C "$REPO_DIR" rev-parse --verify HEAD` equals the SHA **and** `git -C "$REPO_DIR" status --porcelain` is empty.
2. `$REPO_DIR/.worktrees/ship-candidate-<sha>` when that worktree exists, `rev-parse HEAD` equals the SHA, and porcelain is empty.
3. Else create (2) with `git -C "$REPO_DIR" fetch --quiet origin <sha>` then `git worktree add --detach <path> <sha>`. Fail closed if fetch or add fails.
4. `PIPELINE_CANDIDATE_ENGINE_ROOT` (absolute directory) when it exists, `rev-parse HEAD` equals the SHA, porcelain is empty, and `<root>/core/scripts/pipeline.ts` exists. This is the explicit candidate-install path.

After attach, re-check `git rev-parse --verify HEAD` equals the SHA. A dirty or mismatched tree fails closed. Do not reset operator `REPO_DIR` HEAD.

**Rejected as engine roots:**

- `~/.local/bin/pipeline` when that binary's engine-root SHA ≠ candidate SHA
- PATH lookup of `pipeline`
- Any env/train field that is not an absolute directory passing the checks above
- Shell-expanded fragments, newlines in paths, or `eval` of train JSON

**Candidate CLI entrypoint and CWD:**

- Entrypoint: `node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs"` (same launcher as `scripts/pipeline-launcher.mjs`; Node 24 guard + `core/scripts/pipeline.ts`).
- CWD for `gh` and relative paths: `REPO_DIR` (existing Tugboat rule). The executing **module root** is `ENGINE_ROOT`, not cwd HEAD.
- Record the resolved entrypoint in ship state as `ship_end_cli` (absolute path). Subsequent verbs use that recorded path, not a later PATH lookup.

**Identity is exact source SHA.** Package version is display-only. A matching `--version` string with a mismatched SHA SHALL fail. `--version` stays the `core/package.json` version for human text. `pipeline --version --json` SHALL emit `{ "version": "<semver>", "commit_sha": "<40hex>" | null }` using `resolveEngineCommitSha` (never invent a SHA). Doctor and unit helpers compare `commit_sha` to the FRG-bound SHA. They SHALL NOT pass on version equality alone.

### 3. Installed playbook is a thin launcher (single design)

Canonical composer source is `examples/supervisor/shell/tugboat.sh` at the candidate SHA.

`examples/supervisor/shell/pipeline-ship-playbook.sh` SHALL become a thin launcher that execs that repo script:

```bash
exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"
```

`REPO_DIR` must already be set (existing playbook contract). Installed `~/.local/bin/pipeline-ship-playbook` is a copy of that launcher.

Doctor / identity helper treats an installed playbook as:

- **pass** when it is a thin launcher (exec of `$REPO_DIR/examples/supervisor/shell/tugboat.sh`) and the resolved `tugboat.sh` digest matches candidate `tugboat.sh`, **or** the ship execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh` directly and does not invoke the installed playbook
- **fail** when the installed playbook is selected for ship-end and is not that launcher (stale fork, including digest `2afe3c92…` vs candidate tugboat)
- **skip** when no Tugboat, no playbook, and no in-engine ship-end is in use

Marker-only presence SHALL NOT count as parity. Do not keep a second compose implementation in the installed playbook. Existing `supervisor:ship-playbook-promote-host` still applies to a leftover full playbook body; the launcher itself has no promote-host default, so that check skips a launcher body (not a recognized full playbook) unless the ship selected a stale full playbook — then fail with refresh-to-launcher remediation.

### 4. Identity gate is a pure helper plus doctor/source tests

One pure helper (new, next to `tugboat-install-parity.ts`; reuse `contentDigest`) evaluates injected:

- candidate SHA (40 hex)
- invoked engine `commit_sha` (40 hex or null)
- invoked `--version` string (advisory only)
- playbook body or `composer_kind`: `tugboat-repo` | `playbook-launcher` | `playbook-stale` | `in-engine-ship` | `unused`
- whether ship-end tools are in use

Fail when tools are in use and engine `commit_sha` ≠ candidate SHA (including null). Fail when a stale playbook is selected. Skip when unused. Doctor calls it. Unit tests inject strings and digests (no live ship). A Tugboat source assertion fails if post-train invoke sites still use process-start `$PIPELINE` with no `SHIP_END_CLI` rebinding.

Doctor skip is only when **no** thin/in-engine ship-end tool is in use: no installed Tugboat, no installed playbook, and no in-engine ship status whose `next_action` is a post-train phase. Bound SHA identity runs when a factory-release request or ship status carries `integrated_candidate.git_sha` / `integrated_head_oid`. Without a bound SHA, doctor still fails a selected stale full playbook.

Remediation is deterministic: invoke the candidate engine at the FRG-bound SHA; refresh playbook from candidate `examples/supervisor/shell/pipeline-ship-playbook.sh` (launcher) or exec `$REPO_DIR/examples/supervisor/shell/tugboat.sh`.

### 5. In-engine `pipeline ship` spawn-per-verb handoff (no full re-exec)

Do **not** re-exec the whole `pipeline ship` process. Full re-exec would inherit FRG credentials into the candidate and could re-enter train.

The pin process stays the coordinator (`ship.ts` already persists per-phase evidence and resumes from `next_action`). After train is persisted:

1. Resolve the candidate via Decision 2. If resolution fails, persist `last_error` naming the candidate-engine identity defect, leave `train` evidence intact, do **not** start `frg_pack` / release mutation, return non-zero. Retry of the same `pipeline ship --milestone` resumes at `frg_pack` without retraining.
2. For `frg_pack` / `frg_score` / `release_prepare` / `release_finish` / `release_wait` (tag), spawn the candidate CLI (`node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs" <verb>…`) instead of in-process pin `runRelease` / `factory-release-prepare` / `ensureAnnotatedReleaseTag`.
3. Recursion guard: the spawned argv is a leaf CLI verb (`factory-release prepare`, `factory-gate`, `release`, `release finish`), never `ship --milestone`. The pin coordinator does not spawn `pipeline ship`.
4. Credential split (keep #1133): prepare child `env -u PIPELINE_FRG_ATTESTATION_KEY -u PIPELINE_FRG_ATTESTATION_KEY_FILE`. Attestor child is a **separate** spawn with `PIPELINE_FRG_ATTESTATION_KEY` only (KEY_FILE unset in that child). Candidate resolution MUST NOT copy those keys into the request JSON, `ship_end_cli` path, or prepare child env.
5. `engine-promote` stays in-process on the pin (`runEnginePromote`). Publication wait still requires GitHub Release.

If the starting process SHA already equals the candidate SHA, in-process calls on that process are allowed (this process **is** the candidate). Tests fail if pin SHA ≠ candidate and `prepareRelease` / `runRelease` / `ensureAnnotatedReleaseTag` still run in-process.

### 6. Post-train invocation inventory (closed)

Tugboat does not tag. In-engine ship tags via `ensureAnnotatedReleaseTag` (`ship-adapter.ts`, #1115). Do not say "any composer-invoked tag."

| Phase | Command | Tugboat | Installed playbook | `pipeline ship` |
| --- | --- | --- | --- | --- |
| Train `--merge` | `pipeline train --milestone vX.Y.Z --merge --json` | process-start `$PIPELINE` | launcher → Tugboat, same | in-process pin `runTrain` |
| FRG prepare | `pipeline factory-release prepare --request <abs.json> --json` | `SHIP_END_CLI`, uncredentialed child | same | candidate spawn, uncredentialed |
| FRG attestor | `pipeline factory-gate --for X.Y.Z --from-run <loop>` | `SHIP_END_CLI`, separate credentialed child | same | candidate spawn, separate credentialed |
| Release prepare | `pipeline release X.Y.Z --no-edit` | `SHIP_END_CLI` | same | candidate spawn of `release` (not pin `runRelease`) |
| Release finish | `pipeline release finish <pr> --json` | `SHIP_END_CLI` | same | candidate spawn of `release finish` |
| Tag | annotated `vX.Y.Z` on merge commit | **not invoked** (wait for GitHub Release workflow) | **not invoked** | candidate spawn/path of `ensureAnnotatedReleaseTag` inside `waitForPublication` |
| Promote | `pipeline engine-promote --for X.Y.Z --host <host>` | process-start `$PIPELINE` | same | in-process pin `runEnginePromote` |

`--skip-frg` remains an operator escape with a logged reason. It is not the default.

## Risks / Trade-offs

- **[Risk] Candidate checkout missing on the host** → Fail closed with remediation (fetch SHA, attach `.worktrees/ship-candidate-<sha>`, or set `PIPELINE_CANDIDATE_ENGINE_ROOT`). Do not silently use the pin.
- **[Risk] Cwd at pre-train HEAD while CLI is candidate** → Release and FRG request binding already use remote tip / fetch. Tests cover invoke identity, not assume cwd SHA equals candidate SHA.
- **[Risk] Two-track pinning misread as "never run candidate in factory ship"** → Spec delta states ship-end is candidate-track publishing; pinned dogfood stays pinned.
- **[Risk] Installed playbook vs Tugboat fork** → Collapse playbook to a launcher. Fail a selected stale full playbook. Do not accept marker-only parity.
- **[Risk] In-engine ship in-process pin** → Spawn leaf candidate verbs; a test fails if they call in-process pin `runRelease` when pin SHA ≠ candidate.
- **[Risk] FRG credential leak through candidate resolution** → Prepare spawn unsets KEY/KEY_FILE. Attestor is a different spawn. Resolution records only absolute paths and 40-hex SHA.
- **[Risk] Train JSON / env as executable** → SHA and roots are validated as data (`^[0-9a-f]{40}$`, absolute directory, `pipeline.ts` exists). No `eval`.
- **[Risk] Failed candidate release retrains** → `ship.ts` already resumes from persisted `train`. Tugboat already treats prior `train_status complete=true` as resume. Resolution/release failure must not clear that checkpoint.

## Migration Plan

- Land composer + helper + tests on the candidate; this change is the ship-end fix that the next 1.39.x ship must run from a candidate checkout **once** (bootstrap: `PIPELINE_CANDIDATE_ENGINE_ROOT` or worktree at the FRG-bound SHA). After promote of this version, later ships resolve the candidate automatically.
- Rollback: revert the composer to process-start `$PIPELINE` for all phases (returns the 1.39.5 failure mode). No pin write occurs until promote.

## Open Questions

None. Candidate-resolution contract, spawn-per-verb handoff, SHA identity, playbook launcher, and the invocation inventory are decided.
