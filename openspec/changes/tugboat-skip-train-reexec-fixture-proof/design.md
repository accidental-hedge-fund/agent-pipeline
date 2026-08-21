## Context

See `proposal.md` for why. Current law and code:

- Living `tugboat-thin-ship` skip-train requires a `RUN_DIR` proof
  (`train.complete.json`, non-empty `train.json`, or empty-milestone
  stderr/state). #1182 extracted helpers pass that gate.
- After train-complete, Tugboat `exec`s candidate `tugboat.sh` with
  `TUGBOAT_SKIP_TRAIN=1` (#1164). `maybe_reexec_candidate_composer`
  exports skip-train and helper bins. It does not export
  `PIPELINE_SUPERVISOR_STATE` or `REPO_DIR`.
- Four spawn-real-`tugboat.sh` tests (`writeTugboatFrgFixture` plus
  #1151) copy `...process.env` into the child. A live Tugboat
  `pipeline release` child (`npm run ci`) already has
  `TUGBOAT_SKIP_TRAIN=1`. Those tests skip train, find no proof, and
  fail before FRG / candidate assertions.
- Site: ship v1.39.8 `release-prepare.err` at `2026-08-21T06:26:36Z`.
  Local `npm test` without that parent env is green on `000c1f6b`.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is four #1150 / #1151 tests during
   v1.39.8 release CI. The class is: every fixture that spawns real
   `tugboat.sh` for a first-process train must isolate parent skip-train
   env; every fixture that then re-execs the candidate composer must
   leave skip-train proof in that ship `RUN_DIR`; re-exec must export
   `PIPELINE_SUPERVISOR_STATE` and `REPO_DIR` so the candidate sees that
   `RUN_DIR`. A path-local skip of those four names is incomplete.
2. **Shared surfaces.** Shared spawn env / `writeTugboatFrgFixture` in
   `core/test/tugboat.test.ts`. `maybe_reexec_candidate_composer` export
   list in `tugboat.sh`. Living `tugboat-thin-ship` names the fixture
   proof. Do not re-work `skip_train_has_proof`.
3. **Next identical fault.** A later spawn-real-`tugboat.sh` test that
   copies `process.env` without isolating skip-train, or a re-exec that
   drops `PIPELINE_SUPERVISOR_STATE`, fails the same ship-CI class. No
   new mole issue for the same inherited skip-train miss.

## Goals / Non-Goals

**Goals:**

- Shared spawn env for this fixture family deletes inherited
  `TUGBOAT_SKIP_TRAIN` and `TUGBOAT_CANDIDATE_COMPOSER` unless the test
  is asserting skip-train.
- Re-exec fixtures leave skip-train proof in `RUN_DIR` before candidate
  `exec`.
- Re-exec exports `PIPELINE_SUPERVISOR_STATE` and `REPO_DIR`.
- The four named tests keep original FRG / candidate assertions and
  fail on `main` when parent skip-train env is present without isolation
  plus proof.

**Non-Goals:**

- Changing `skip_train_has_proof` or empty-milestone resume (#1182).
- HMAC JSON, `--skip-frg`, `git tag`, stage-watch argv, killing a live
  ship.
- Rewriting the four tests into skip-train-only checks.
- Merging inside advance/loop.

## Decisions

### 1. Isolate inherited skip-train env; do not only plant proof

**Choice:** The shared spawn env used by `writeTugboatFrgFixture` and
the #1151 candidate-engine tests SHALL omit `TUGBOAT_SKIP_TRAIN` and
`TUGBOAT_CANDIDATE_COMPOSER` from `process.env` unless the test is
itself a skip-train assertion. Planting `train.complete.json` alone is
not enough for tests that must still invoke pin `train`.

**Why:** v1.39.8 CI inherited `TUGBOAT_SKIP_TRAIN=1` from Tugboat
release. Skip-train ran on the first process. Train never ran. The
#1151 pin-argv test requires pin `train` and candidate
`factory-release`. The unavailable-engine test must reach candidate
resolution fail, not skip-train fail. Isolation restores first-process
train. Proof then covers the later candidate re-exec.

**Alternatives considered:**

- Plant `train.complete.json` and keep inherited skip-train → rejected;
  pin never sees `train`; original assertions change meaning.
- Unset skip-train only in the four named tests, no shared helper →
  rejected; class-over-site. The next spawn-real-`tugboat.sh` test
  repeats the mole.
- Filter the whole `TUGBOAT_*` env → rejected; tests still need
  `TUGBOAT_CANDIDATE_SHA`, `TUGBOAT_BASE_BRANCH`,
  `TUGBOAT_OPEN_RELEASE_PR`, `TUGBOAT_REPOSITORY`.

### 2. Leave skip-train proof in RUN_DIR before candidate re-exec

**Choice:** After the fixture’s own train (fake `complete:true` or
resume), `RUN_DIR` SHALL contain a skip-train proof before
`maybe_reexec_candidate_composer`. Prefer the existing
`ensure_train_complete_artifact` path (non-empty `train.json` copied or
synthetic `train.complete.json`). `writeTugboatFrgFixture` MAY also
write a non-empty `train.complete.json` into the ship `RUN_DIR` so a
re-exec cannot start without proof even if train capture is empty.

**Why:** Candidate `tugboat.sh` is a different path, so re-exec happens.
Skip-train then requires proof in that `RUN_DIR`. #1182 already writes
the artifact on a successful/resumed train. Fixtures must not skip that
writer and must not re-exec into an empty `RUN_DIR`.

**Alternatives considered:**

- Disable re-exec in tests (`self == cand`) → rejected; that hides the
  candidate-composer path the tests exist to cover.
- Point candidate `tugboat.sh` at a stub that ignores skip-train →
  rejected; #1150 / #1151 must run the real composer after re-exec.

### 3. Re-exec exports PIPELINE_SUPERVISOR_STATE and REPO_DIR

**Choice:** `maybe_reexec_candidate_composer` SHALL `export`
`PIPELINE_SUPERVISOR_STATE` (the same value as `STATE_ROOT`) and
`REPO_DIR` before `exec bash "$cand"`. Keep the existing skip-train and
helper-bin exports.

**Why:** `RUN_DIR` is `$STATE_ROOT/ship-v…`. `STATE_ROOT` is read from
`PIPELINE_SUPERVISOR_STATE` at process start. If that var is a shell
local and not exported, the candidate recomputes state under
`$HOME/.local/state/pipeline-supervisor` and skip-train sees no proof.
`REPO_DIR` is already exported at pin time; re-export at exec is
defense in depth for the same `RUN_DIR` / worktree.

**Alternatives considered:**

- Rely on spawnSync env inheritance only → rejected; production
  re-exec is `exec bash`, not Node `spawnSync`. The v1.39.8 tests
  already inherit env and still missed proof because skip-train was
  set. The composer must export the vars the candidate process-start
  reads.
- Pass `RUN_DIR` as a new env var → rejected; candidate process-start
  already derives `RUN_DIR` from `PIPELINE_SUPERVISOR_STATE`. Do not
  add a second state root.

### 4. Regression bites main under parent skip-train env

**Choice:** Keep the four original assertions. Add a fixture or env
injection that sets `TUGBOAT_SKIP_TRAIN=1` in `process.env` the way
ship CI does. Without isolation plus proof, those tests SHALL fail
with the skip-train FAIL line (as on `000c1f6b` during v1.39.8
release). With isolation plus proof they SHALL pass and still match
FRG / candidate argv, live-wait ticks, not-live fail-closed, and
unavailable-engine text.

**Why:** AC 2 requires a bite on current `main` without the fixture
proof. Local test without parent skip-train env is not that bite.

**Alternatives considered:**

- Source-only `assert.match` on `writeTugboatFrgFixture` → rejected;
  that would not have failed v1.39.8 CI.
- Delete the four tests and rely on #1182 extract helpers → rejected;
  those tests are the FRG / candidate coverage.

## Risks / Trade-offs

- **[Risk] Isolation hides a real skip-train product bug.** →
  Mitigation: #1182 extract tests still fail closed without proof.
  This change does not weaken `skip_train_has_proof`.
- **[Risk] Shared env helper is too broad and drops needed Tugboat
  vars.** → Mitigation: delete only `TUGBOAT_SKIP_TRAIN` and
  `TUGBOAT_CANDIDATE_COMPOSER`. Keep SHA / branch / repository vars.
- **[Risk] Synthetic `train.complete.json` in the fixture skips the
  real writer.** → Mitigation: prefer train capture plus
  `ensure_train_complete_artifact`. Extra fixture file is a backstop,
  not a replacement for the writer on the product path.
- **[Trade-off] Other spawn-real-`tugboat.sh` tests (skip-frg fixtures)
  may still inherit skip-train.** → Class says they should use the
  same isolation. Scope the shared helper so those spawn sites can
  call it without rewriting skip-frg assertions. Do not expand into
  unrelated FRG pack behavior.

## Migration Plan

1. Land fixture isolation + proof and the re-exec export on this
   branch. No engine schema change.
2. Merge. Next `pipeline release` CI under a live Tugboat skip-train
   env reaches the original FRG / candidate assertions.
3. Rollback: revert the test/composer/spec change. Ship CI fails the
   four tests again when Tugboat re-exec has `TUGBOAT_SKIP_TRAIN=1`.

## Open Questions

None.
