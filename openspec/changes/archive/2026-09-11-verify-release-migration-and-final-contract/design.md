## Context

See `proposal.md` for motivation. This is package 5 of 5. Packages 1–3 already shipped no-change Tester proof, exact-candidate FRG, and independently complete `pipeline release`. Package 3 already made SemVer `pipeline ship --milestone` call `runCompleteRelease` once. Package 4 (#1560) retires remaining obsolete factory-protocol callers; this package does not implement that retirement.

The live contract is already mostly in code (`runCompleteRelease`, `ship-adapter.completeRelease`). The remaining defect is incoherent product surfaces and leftover failed synthetic state:

- `OPERATION_SURFACE` still lists `release finish` in the live usage line.
- Living `ship-coordinator` still requires factory-pack FRG, `release finish`, `engine-promote`, and install as the live tail.
- Ordinary docs still mix the current contract with Tugboat FRG / finish / ensure-tag / promote "pending #1560".
- Old HMAC `latest.json`, scorer, attestor, and failed-ship ledgers can look like current-candidate authority.

The first holding rung is to reuse those existing seams. Do not add a second catalog, coordinator, scorer, attestor, or scheduler.

## Goals / Non-Goals

**Goals:**

- Make one live command contract across `OPERATION_SURFACE`, generated host SKILLs, generated `docs/cli.md`, ordinary operator docs, and living specs.
- Keep historical optional-FRG, finish-as-release-owner, and ship-promotion identifiable as historical.
- Treat historical-failed-ship-evidence as superseded history, not current-candidate authority.
- Prove the approved command-interface case list on existing test seams.
- Add ownership-safe cleanup and migration of known failed synthetic artifacts on the existing FRG cleanup identity checks.
- Record an unchecked operator post-merge live checklist.
- Report protected-file alignment without editing those files.

**Non-Goals:**

- Live FRG, tag, publication, install, promotion, or deployment.
- Package 4 caller retirement (#1560).
- A new release engine, catalog module, migration scheduler, or synthetic fixture implementation.
- Hand-edits of ledgers or deletion of diagnostic evidence to reset budgets.
- Edits to protected `CLAUDE.md`, rules, settings, or commands.
- Weaker review, weaker CI, skip-FRG, or forged evidence as a passing path.

## Decisions

### 1. Catalog text stays on OPERATION_SURFACE

Host SKILLs and `docs/cli.md` already overlay `OPERATION_SURFACE`. Edit the `release` and `ship` rows there, then run `node scripts/build.mjs` and the docs generator. Do not add a parallel catalog.

`release` live usage is `pipeline release VERSION` (direct-release), plus explicit `release prepare` as the bounded metadata helper. `release finish` and `release ensure-tag` are not the live complete-release contract. If they remain dispatchable, the catalog summary labels them as a metadata-PR merge helper or as historical.

`ship` live summary is train, then exactly one complete-release delegation. It names no install, promotion, or deployment.

Alternative considered: a new `release-contract.ts` module. Rejected because `OPERATION_SURFACE` is already the catalog owner.

### 2. Ship living spec follows the existing completeRelease seam

Keep `ship-adapter.completeRelease` → `runCompleteRelease`. Change living `ship-coordinator` so the live SemVer tail is that one call. Remove factory-pack FRG, `release finish`, `ensure-tag`, `engine-promote`, and install from the live phase order. Exact-candidate FRG stays inside complete release, not as a ship-owned factory-pack.

`engine-promote` remains a separate operator command. Ship does not gain or keep promote/install authority.

Alternative considered: keep the old ship-coordinator requirements and add a "preferred path" note. Rejected because living specs would still describe the obsolete tail as required.

### 3. Historical procedures stay readable, not live

Ordinary docs (`docs/runbooks/ship-milestone.md`, `docs/supervisor.md`, FRG runbooks) keep historical optional-FRG, finish, and ship-promotion text only when a heading or equivalent label marks them historical. They are not the live procedure.

Living specs that currently require those steps as live ship phases are modified or removed with a migration note to the historical docs label.

### 4. Historical-failed-ship-evidence has no current-candidate authority

Reuse the package-3 observer rule: Git, forge, CI, review, Tester, workflow, and Release facts are authority. Local HMAC `latest.json`, scorer output, attestor files, and failed-ship ledgers may remain on disk as historical-failed-ship-evidence. They MUST NOT prove the current candidate and MUST NOT be a prerequisite for a new release.

A new release of the current candidate MUST succeed when those old files are absent, unreadable, or record a historical pass for a different candidate. A historical pass MUST NOT authorize the current candidate.

Alternative considered: delete all old ledgers during implementation. Rejected because the issue forbids deleting diagnostic evidence to reset budgets and forbids hand-edits of ledgers.

### 5. Ownership-safe migration reuses FRG cleanup identity checks

Known failed synthetic artifacts are recorded fixture issues, PRs, branches, worktrees, and release-owned synthetic records whose provenance matches a failed exact-candidate or factory-pack identity. Cleanup and migration use the existing ownership-safe compare-and-swap checks in exact-candidate FRG cleanup:

- Persist proof or classification first.
- Mutate only identities that still match the recorded provenance.
- Never merge, never close unrelated issues or pull requests, never delete user worktrees.
- Record uncertainty as cleanup debt.
- Do not treat a simulated test cleanup as proof that an operator completed live cleanup.

Tests inject I/O or use isolated real Git fixtures. The operator performs actual scoped failed-artifact cleanup after those checks, outside this issue's done bar.

Alternative considered: a new host-wide janitor. Rejected because it would close unrelated issues, delete user worktrees, or become a second scheduler.

### 6. Command-interface coverage is an inventory over existing suites

Do not invent a new test harness. Add a deterministic inventory that names every approved case and asserts a covering test exists in the existing suites (`release-complete`, `exact-candidate-frg`, `ship-adapter`, Tester no-change/changed-candidate, dirty pre-commit CI). Fill only the gaps.

Approved cases: milestone integration checks; isolated metadata-first merge; candidate source identity; exactly two issues across partial create and resume; same-host duplicate exclusion; fresh genuine `pipeline:ready-to-deploy`; rejection of false, forged, wrong-head, and mismatched evidence; no fixture merging; correct external-wait versus regression handling; unchanged and changed Tester candidates; dirty pre-commit CI; stale main; tag and publication idempotency; cleanup debt; equivalent direct-release and ship-final-delegation without deployment.

False, forged, wrong-head, and mismatched evidence remain fail-closed. Fixture merging is not a passing path.

### 7. Protected files are reported, not edited

Scan in-repo `CLAUDE.md`, `AGENTS.md`, `.claude/rules`, `settings.json`, and `commands/` for disagreement with the live contract. Write a committed alignment report. If they already agree, the report says so. Do not edit those files in this change.

### 8. Operator checklist stays unchecked

Add a committed operator checklist whose items stay unchecked until post-merge live observation:

- Test exact main `C`.
- Obtain two unmerged `pipeline:ready-to-deploy` results.
- Create annotated `v1.40.1` at `C`.
- Verify matching versions and notes and a non-draft publication.
- Prove a repeated release of that publication is idempotent.

This issue does not check those items. Independently verified publication completes the goal, not this package.

## Risks / Trade-offs

- [Package 4 (#1560) is still open] → This package specifies the coherent contract after that retirement. Implementation of catalog and spec alignment can proceed on surfaces package 3 already owns. Do not re-implement package 4 caller deletion here.
- [Living ship-coordinator still requires the obsolete tail] → Modify or remove those live requirements in this change so archive does not keep a contradictory law.
- [Old HMAC files still exist on operator hosts] → Treat them as historical-failed-ship-evidence. Do not make their presence or absence a release prerequisite. Do not delete them to reset budgets.
- [Cleanup of failed synthetic artifacts can touch shared forge resources] → Restrict mutation to recorded provenance with current identity checks. Tests never close unrelated issues or delete user worktrees.
- [Docs that still describe Tugboat FRG/finish/ensure-tag as pending #1560] → Relabel them historical. Do not leave "pending" as if they were the live product path.
- [Protected CLAUDE.md or host commands may still mention the old tail] → Report the required alignment. Do not edit protected files.

## Migration Plan

1. Align `OPERATION_SURFACE` release and ship rows, regenerate host SKILLs and `docs/cli.md`.
2. Update ordinary operator docs so the live procedure matches direct-release and ship-final-delegation, and historical sequences are labeled historical.
3. Change living `ship-coordinator` and `release-simplification-contract` to the package-5 contract.
4. Add historical-failed-ship-evidence fail-closed tests and ownership-safe migration tests on existing seams.
5. Add the approved-case inventory and fill gaps.
6. Write the protected-file alignment report and the unchecked operator checklist.
7. Run `node scripts/build.mjs`, docs check, `openspec validate --all`, focused tests, and `npm run ci`.

Rollback is code rollback before merge. Historical evidence files stay on disk. This package never creates `v1.40.1` or publishes.

## Open Questions

None. Live publication stays a separate operator invocation after merge.
