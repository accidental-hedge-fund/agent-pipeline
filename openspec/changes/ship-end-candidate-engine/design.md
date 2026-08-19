## Context

See `proposal.md` for why. Current law and code:

- Tugboat pins `PIPELINE="${PIPELINE:-pipeline}"` at process start (`examples/supervisor/shell/tugboat.sh`). Every phase, including FRG pack, `pipeline release`, and `release finish`, uses that binary. Factory ship sets it to `~/.local/bin/pipeline`, which is the last promoted pin.
- Living `tugboat-thin-ship` says the composer uses "the installed Pipeline CLI" for the whole sequence. Living `release-sub-command` says wrappers **MAY** invoke `factory-release prepare` from the exact integrated candidate when the pin is one release behind. Tugboat does not take that MAY.
- Living `factory-two-track-engine-pinning` reserves the candidate track for FRG Layer B and eval soaks, and forbids silently running the candidate as pinned production. That is a different use than ship-end publishing.
- Option 1 pack parity (`tugboat-install-parity.ts`) compares installed Tugboat to local repo examples. It does not bind the candidate SHA being released. It does not check `$PIPELINE --version`. 1.39.4 promote did not refresh `~/.local/bin/pipeline-ship-playbook`.
- Tugboat already binds `integrated_candidate.git_sha` to the remote integration tip, not local `HEAD`. Local `REPO_DIR` often stays at the pre-train SHA. Candidate **code** and candidate **SHA** are therefore distinct from cwd.

**Conflict (do not average):** "use the installed Pipeline CLI for every phase" contradicts "MAY invoke prepare from the candidate when the pin is behind" and contradicts this issue. This change **supersedes** the installed-CLI rule for post-train FRG / release / finish / tag. Train stays on the pin. Two-track pinning is not averaged: ship-end is a documented candidate-track publishing use, not a silent dogfood reclassification.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is 1.39.5 Tugboat invoking `PIPELINE=…/pipeline` version 1.39.4 for release, plus a stale playbook digest. The class is: any ship-end composer that scores or publishes the candidate while still executing the previous production-pin CLI.
2. **Shared surfaces.** Candidate-engine resolution after train-complete; ship-end identity gate (`--version` / source SHA / playbook digest vs candidate SHA). Law lives in `ship-end-candidate-engine`, adopted by `tugboat-thin-ship`, `supervisor-ship-playbook`, `ship-coordinator`, `release-sub-command`, and `factory-two-track-engine-pinning`.
3. **Next identical fault.** The next pin-behind-candidate ship runs ship-end on the candidate engine. Tests fail if FRG/release/finish still use process-start `$PIPELINE` when pin identity ≠ candidate. No new mole issue.

## Goals / Non-Goals

**Goals:**

- After train-complete, ship-end verbs execute candidate engine code at the FRG-bound SHA.
- Installed playbook matches candidate `tugboat.sh`, or the composer execs the repo script from `REPO_DIR`.
- A hermetic check fails on pin/playbook mismatch when those tools are used for ship-end.
- Keep Tugboat a thin composer of existing CLI verbs. Keep train on the production pin.

**Non-Goals:**

- Running implementer/review harnesses on the unpromoted candidate for train items.
- `--skip-frg` as the ship path.
- Auto-promoting before GitHub Release.
- Changing FRG attestor isolation, pack-done, or two-track pin write rules.
- Making `engine-promote` switch engines in this change (promote consumes a published tag; it is not in the issue ship-end set).
- Checking out or force-resetting operator `REPO_DIR` `HEAD` as the only resolution path.

## Decisions

### 1. Switch after train-complete, not at process start

Train `--merge` stays on process-start `$PIPELINE` (production pin). After train is complete or resumed complete, the composer resolves the candidate engine and uses it for FRG pack, release, finish, and any composer-invoked tag.

**Why not switch `$PIPELINE` at Tugboat start:** the candidate SHA is not known until after train merges through GitHub. Switching early would run train on unpromoted engine, which is an explicit non-goal.

**Alternative considered:** run the entire ship, including train, from a floating `main` checkout. Rejected: two-track pinning and the issue non-goals require train on the pin.

### 2. Candidate engine identity is the FRG-bound SHA, not cwd HEAD

Resolve the candidate as:

1. A control checkout or managed worktree whose `HEAD` (or recorded source SHA) equals the FRG-bound `integrated_candidate.git_sha`, then invoke that tree's `core/scripts/pipeline.ts` (Node type-stripping, same as the installed CLI), **or**
2. An explicit candidate install whose installer receipt / version identity names that SHA.

Fail closed if neither matches. Do not fall back to `~/.local/bin/pipeline` when that binary's version or source SHA differs.

Cwd MAY remain `REPO_DIR` for `gh` and relative paths (existing Tugboat rule). The executing **module root** SHALL be the candidate tree. Release already must not bind candidate SHA to pre-train local `HEAD`.

**Why not `cd` and reset `REPO_DIR`:** that mutates the operator checkout and races other host processes. A managed worktree or already-matching control checkout is enough to load candidate `release.ts`.

**Alternative considered:** `npx github:…#<sha>` on every ship-end verb. Allowed as the explicit candidate install path; not required if a checkout at that SHA already exists.

### 3. Playbook: digest vs candidate `tugboat.sh`, or exec the repo script

Two accepted postures:

- Installed `pipeline-ship-playbook` (or installed Tugboat) content digest equals `examples/supervisor/shell/tugboat.sh` at the candidate SHA.
- Composer execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh` and does not use the divergent installed playbook for ship-end.

Reuse the existing `contentDigest` helper. Canonical bytes come from the candidate SHA (read from the resolved candidate tree), not from a stale local `HEAD` or a leftover install-root.

### 4. Identity gate is a pure helper plus doctor/source tests

One pure helper evaluates:

- invoked ship-end CLI version or source SHA vs candidate SHA / candidate package version
- playbook digest vs candidate `tugboat.sh`
- skip when those tools are absent and unused

Doctor calls it. Unit tests inject strings and digests (no live ship). A Tugboat/playbook source assertion fails if post-train invoke sites still use process-start `$PIPELINE` with no rebinding.

`--version` vs SHA: fail when either the reported version does not match the candidate package version bound to that SHA, or the CLI source SHA does not match the candidate SHA. Pin `1.39.4` vs candidate `1.39.5` is the 1.39.5 fixture.

### 5. In-engine `pipeline ship` re-execs the candidate for post-train phases

If the operator started production-pin `pipeline ship`, the coordinator SHALL spawn or re-exec the candidate `pipeline.ts` for FRG / release / finish / tag. In-process calls from the pin process are the same class bug as Tugboat `$PIPELINE`.

**Alternative considered:** document that operators must start ship from a candidate checkout. Rejected: Buzz / Tugboat start from the pin by design; class law must not depend on a human picking the binary.

### 6. engine-promote stays on the process-start CLI in this change

The issue ship-end set is prepare, release, finish, and tag. Promote consumes a published GitHub Release and updates the pin. Leave promote on process-start `$PIPELINE` unless a later change expands the set. Do not auto-promote before publication.

## Risks / Trade-offs

- **[Risk] Candidate checkout missing on the host** → Fail closed with remediation (fetch SHA, attach worktree, or candidate install). Do not silently use the pin.
- **[Risk] Cwd at pre-train HEAD while CLI is candidate** → Release and FRG request binding already use remote tip / fetch. Tests must cover invoke identity, not assume cwd SHA equals candidate SHA.
- **[Risk] Two-track pinning misread as "never run candidate in factory ship"** → Spec delta states ship-end is candidate-track publishing; pinned dogfood stays pinned.
- **[Risk] Installed playbook vs Tugboat fork** → Digest against candidate `tugboat.sh` (issue text) or exec that script from `REPO_DIR`. Do not accept marker-only parity.
- **[Risk] In-engine ship in-process pin** → Ship-adapter post-train phases spawn the candidate CLI; a test fails if they call in-process pin `runRelease` when pin SHA ≠ candidate.

## Migration Plan

- Land composer + helper + tests on the candidate; this change is the ship-end fix that the next 1.39.x ship must run from a candidate checkout **once** (bootstrap). After promote of this version, later ships resolve the candidate automatically.
- Rollback: revert the composer to process-start `$PIPELINE` for all phases (returns the 1.39.5 failure mode). No pin write occurs until promote.

## Open Questions

None. Candidate resolution (checkout at FRG-bound SHA vs explicit install), train-vs-ship-end split, and playbook postures are decided. Implementation may pick worktree vs already-matching control checkout without changing the specs.
