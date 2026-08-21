## Context

See `proposal.md` for why. Current law and code:

- Living `tugboat-thin-ship` treats train exit “has no open issues” as
  already complete (`train_resumed=1`) and does not re-fail the complete
  gate on that capture.
- Fresh success copies `train.json` → `train.complete.json`. Resume
  (`train_resumed=1`) does not write that file.
- After train-complete, Tugboat `exec`s candidate `tugboat.sh` with
  `TUGBOAT_SKIP_TRAIN=1` (#1164). Skip-train requires `-s`
  `train.complete.json` or `-s` `train.json`.
- Empty-milestone train writes nothing to stdout, so `train.json` is 0
  bytes. Skip-train then fails. Site: ship v1.39.7 at
  `2026-08-20T18:34:04Z`.
- `ship_one` declares `local lock_dir`, defines `release_lock` against
  that name, then `trap 'release_lock' EXIT`. After a successful ship
  the EXIT trap runs outside the function; `set -u` prints
  `lock_dir: unbound variable` (line 2210).

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is empty-milestone v1.39.7 skip-train
   fail plus the post-success trap. The class is: every already-complete
   train resume must leave a skip-train-acceptable artifact; skip-train
   must accept that artifact **or** RUN_DIR no-open-issues evidence so
   a stale process-start composer can re-exec a fixed candidate; EXIT
   and RETURN lock release must not dereference unbound locals under
   `set -u`. A human `git merge --ff-only` of `REPO_DIR` is not the
   class fix.
2. **Shared surfaces.** Named helpers in `tugboat.sh` (resume artifact,
   skip-train gate, lock release). Living `tugboat-thin-ship` is the
   spec. Tests extract those helpers. No new human-authority class:
   empty milestone is already-complete train, not `needs-human`.
3. **Next identical fault.** A later resume path that sets
   `train_resumed` without a non-empty complete file, or a skip-train
   gate that still requires `-s` only, fails the extract tests. A later
   EXIT trap that uses an unbound local fails the trap probe. No new
   mole issue for the same empty-milestone re-exec or the same trap.

## Goals / Non-Goals

**Goals:**

- Resume (no-open-issues or prior complete) writes a non-empty
  `train.complete.json` before re-exec.
- Skip-train accepts that file, a non-empty `train.json`, or RUN_DIR
  no-open-issues evidence.
- Optional porcelain-clean `REPO_DIR` fast-forward; never force-ff dirty.
- EXIT/RETURN lock release is `set -u` safe.
- Extracted-helper tests fail on the 1.39.7 bodies.

**Non-Goals:**

- Human control-checkout fast-forward as the product path.
- HMAC JSON, `--skip-frg`, `git tag`, KEY_FILE loader, pin-path identity.
- v1.40.0 packaging.
- Changing train CLI empty-milestone semantics.
- Merging inside advance/loop.

## Decisions

### 1. Extract named helpers from ship_one; do not keep inline-only law

**Choice:** Extract three named functions from `examples/supervisor/shell/tugboat.sh` and call them from `ship_one`:

- `ensure_train_complete_artifact` — if `train.complete.json` is already
  non-empty, keep it; else if `train.json` is a non-empty success
  capture, copy it; else write a synthetic `{"kind":"train_status","complete":true}`
  (plus the resume reason in a non-blocker field or log). Never copy a
  0-byte `train.json` onto `train.complete.json`.
- `skip_train_has_proof` — true when `-s train.complete.json` or
  `-s train.json` or RUN_DIR `state.json` / `train.stderr` records
  no-open-issues resume.
- `release_lock` — no-op when `lock_dir` is unset; otherwise remove
  `$lock_dir` as today.

**Why:** `extractNamedFn` cannot extract inline `ship_one` branches.
Issue #1182 requires tests that fail on the 1.39.7 helpers and pass on
the fixed helpers. Named functions are the class surface: every resume
path must call the same writer; skip-train must call the same gate.

**Alternatives considered:**

- Only `assert.match` on `tugboatShipOneBody` → rejected; that does not
  execute the 0-byte fixture and would not bite skip-train.
- Keep inline and wrap a slice of `ship_one` in the test → rejected;
  brittle and does not force the next resume path to share the writer.
- Copy 0-byte `train.json` when resumed → rejected; `-s` still fails.

### 2. Skip-train accepts RUN_DIR no-open-issues evidence (chicken-egg)

**Choice:** Candidate skip-train SHALL continue when process-start left
0-byte `train.json` and no `train.complete.json` if `train.stderr`
contains `has no open issues` (case-insensitive, same grep as resume)
or `state.json` already recorded train `ok` with that resume detail.

**Why:** Process-start Tugboat is the writer. After this SHA is on
origin/main, the next empty-milestone ship still starts a stale
process-start script until `REPO_DIR` catches up. User story forbids a
human fast-forward. Optional ff is MAY and must not run on a dirty
checkout. Without this clause the next identical fault still needs a
mole. The 1.39.7 process-start already writes state `ok` /
`no open issues (already shipped)` and greps stderr before re-exec.

**Alternatives considered:**

- Require the complete file only (AC 1 + AC 2 literal) → insufficient
  for stale process-start + candidate re-exec.
- Make porcelain-clean ff a SHALL → rejected; issue marks ff optional
  and forbids force-ff of a dirty checkout. Dirty hosts would still
  need skip-train evidence.
- Disable re-exec when resumed → rejected; re-exec is the intended
  chicken-egg path when process-start Tugboat is stale.

### 3. Optional porcelain-clean ff at process start; never fail the ship

**Choice:** Best-effort helper at process start (before `ship_one`
train): if porcelain is empty, `git fetch` and `git merge --ff-only
origin/<base>`. Same `<base>` as the factory-release request. If the
running script path is under `REPO_DIR` and HEAD moved, `exec` that
path so bash does not continue a rewritten file. Dirty porcelain,
failed fetch, or failed ff: log and continue. Do not `reset --hard`.
Do not fail the ship.

**Why:** Issue AC 3 is MAY. It reduces chicken-egg when the control
checkout is clean. It must not become a new ship-fail class. Bash
re-reads a running script; exec-after-ff is the safety for the
in-tree composer path.

**Alternatives considered:**

- Human `git merge --ff-only` → rejected; that is the 1.39.7 retry, not
  product.
- Force-ff dirty trees → rejected by AC 3.
- ff after train → rejected; train already ran; skip-train proof is
  the post-train class.

### 4. Guard lock_dir in release_lock; keep the EXIT and RETURN traps

**Choice:** `release_lock` uses `"${lock_dir:-}"` (or
`"${lock_dir:-$RUN_DIR/lock}"` while `RUN_DIR` is set) and returns
when the path is empty. Keep `trap 'release_lock' RETURN` and
`trap 'release_lock' EXIT`. Bind `lock_dir="$RUN_DIR/lock"` before
installing the traps (already true after the assignment today). Do
not remove the EXIT trap.

**Why:** Issue names bind-before-trap or guard-the-trap. The 1.39.7
failure is EXIT after `ship_one` locals are gone, not a missing
assignment inside the function. A guard survives that. RETURN still
releases while `lock_dir` is bound.

**Alternatives considered:**

- Drop EXIT trap; keep RETURN only → rejected; a non-function exit
  path would leak the lock.
- Global `lock_dir` without `local` → works, but a missed assign still
  trips `set -u` inside the function body. Guard is the class.
- `trap - EXIT` on success before return → extra control flow; still
  need a safe release on error.

### 5. Tests extract helpers and fixture the 1.39.7 bodies

**Choice:** Add co-located tests in `core/test/tugboat.test.ts`:

- Resume writer + skip-train gate: temp `RUN_DIR`, 0-byte `train.json`,
  `train.stderr` with `has no open issues`, no `train.complete.json`.
  Assert the 1.39.7 inline/helper behavior fails skip-train. After the
  fix, assert non-empty `train.complete.json` and skip-train success.
  Second fixture: skip-train with only stderr/state proof (no complete
  file) succeeds on the fixed gate.
- Lock probe: `set -u` bash snippet that defines `release_lock` as
  extracted, unsets `lock_dir`, fires EXIT. 1.39.7 body prints
  unbound; fixed body does not.

Reuse `extractNamedFn`. No live train, network, git, or ship
subprocess. If `core/test/` changes, run `node scripts/build.mjs` in
the same change.

**Why:** AC 4 and AC 5 require a bite on the 1.39.7 helpers.

**Alternatives considered:**

- Source-only regex on `train_resumed` → already exists and did not
  catch this bug.

## Risks / Trade-offs

- **[Risk] Synthetic complete JSON is not a real train_status.** →
  Mitigation: shape is the last object `kind=train_status` with
  `complete: true` and no blocker, which `train-status-complete.py`
  already accepts. Do not invent HMAC or merge evidence.
- **[Risk] Skip-train evidence from stderr is too broad.** →
  Mitigation: reuse the same `has no open issues` grep the resume
  branch already uses. Do not treat arbitrary train stderr as
  complete.
- **[Risk] Optional ff rewrites the running script.** → Mitigation:
  exec the in-tree path after a successful ff; skip ff when dirty.
- **[Risk] Stale installed `~/.local/bin/tugboat` still writes no
  artifact.** → Mitigation: candidate skip-train evidence clause.
  Re-exec remains the chicken-egg path.
- **[Trade-off] Optional ff is not a SHALL.** Dirty control checkouts
  rely on skip-train evidence, not a refreshed process-start script.

## Migration Plan

1. Land named helpers + unit tests on this branch. No engine schema
   change.
2. Merge. Next empty-milestone `Ship milestone` may still start a
   stale process-start Tugboat. Candidate skip-train continues from
   RUN_DIR evidence, then FRG / ensure-tag.
3. Once this SHA is process-start (clean ff or later install), resume
   also writes `train.complete.json` for later re-execs.

Rollback: revert the composer/test/spec change. Empty-milestone
skip-train fails again. EXIT trap prints `lock_dir: unbound variable`
again.

## Open Questions

None.
