## Context

See `proposal.md` for why. Current law and code:

- `runFactoryReleasePrepare` requires an absolute `--request` path and
  then reads it. It does not check whether that path sits inside
  `opts.repoDir` or the factory control checkout.
- `.agent-pipeline/` is not fully gitignored. The artifact ignore
  contract lists named subdirs (`runs/`, `roadmap/`, `history/`,
  `evals/`, `frg/`, `harness-ownership/`, …). A file at
  `.agent-pipeline/request-1.39.13.json` is untracked porcelain.
- Tugboat already writes `$RUN_DIR/factory-release-prepare-request.json`
  with `STATE_ROOT="${PIPELINE_SUPERVISOR_STATE:-$HOME/.local/state/pipeline-supervisor}"`.
  In-engine ship already writes under `AGENT_PIPELINE_STATE_HOME`. The
  1.39.13 failure was a manual / operator request inside the control
  checkout, not Tugboat's dest formula.
- Prepare itself writes `.agent-pipeline/factory-release/<fingerprint>/`
  (checkpoint, loop binding) under `repoDir`. That directory is **not**
  in the ignore contract. An off-repo `--request` can still dirty
  protected `main` at dispatch unless that tree is ignored or moved.
- Doctor `worktree-clean` is correct. It must keep failing unignored
  dirt on a protected branch. Do not classify the request file as
  engine scratch.

**Class vs site (engine-dogfood bar):**

| | |
| --- | --- |
| **Site** | `--request $REPO_DIR/.agent-pipeline/request-1.39.13.json` for FRG 1.39.13. Pack loop doctor `worktree-clean` → `run_fatal`, `dispatched: 0`. |
| **Class** | Operator-supplied `--request` files are not repo files. Engine-written prepare runtime dirs join the ignore contract. Composers keep request dest off-repo. |
| **Shared surfaces** | Pure path-containment helper on prepare admission; `ARTIFACT_CONTRACT` entry for `factory-release/`; composer dest tests. |
| **Next identical fault** | Same tests fail if prepare accepts an in-checkout request, if `factory-release/` is dropped from ignore, or if Tugboat / ship-adapter dest resolves inside `REPO_DIR`. |

A gitignore of one `request-*.json`, `skip-worktree` on one host, or a
doctor exception for `.agent-pipeline/*.json` is not the class fix.

## Goals / Non-Goals

**Goals:**

- Fail closed at prepare admission when `--request` resolves inside the
  target checkout, with a named defect and off-repo remediation.
- Keep FRG / prepare scratch off porcelain via the existing ignore
  contract (`frg/` unchanged; add `factory-release/`).
- Lock Tugboat `$RUN_DIR` and ship-adapter state-home dests so a later
  in-checkout writer fails the same tests.
- Document off-repo request placement in the FRG runbook and prepare help.

**Non-Goals:**

- Loop `run_fatal` resume (sibling issue).
- All-integrated ship freeze (#1252).
- Non-durable fallback; skipping FRG; merging inside advance/loop.
- Doctor ignoring in-checkout request files.
- Gitignoring all of `.agent-pipeline/` (the factory pin file lives
  there and is not an ignore-contract artifact).
- Moving prepare checkpoints to `AGENT_PIPELINE_STATE_HOME` in this
  change (ignore-contract membership is the `frg/`-class fix).
- Changing request JSON schema, pack-loop binding, or attestation.

## Decisions

### 1. Refuse in-checkout `--request`; do not gitignore operator request files

**Choice:** Shared admission helper: resolve the path (absolute, then
`realpath` of the file or its parent when it exists) and reject when it
is the checkout root or a descendant of `repoDir` and of the factory
control checkout when that root is distinct. Gitignored descendants
still fail. Symlink targets inside the checkout still fail.

**Why not gitignore `request-*.json`:** that accepts operator dirt in the
checkout and hides the next file that is not named `request-*.json`.
The factory pin at `.agent-pipeline/production-engine-pin.json` also
shows why a blanket `.agent-pipeline/*.json` ignore is unsafe.

**Why not doctor scratch:** `worktree-clean` is the detector. Widening
scratch classification would hide product dirt next to the request file.

**Admission shape:** match today's relative-path refuse: throw / CLI
non-zero before JSON success. Message MUST contain a stable token
(`request_inside_checkout`), the request path, the checkout root, and
remediation naming `$TMPDIR` / state dir / Tugboat `$RUN_DIR`.

### 2. Add `.agent-pipeline/factory-release/` to the artifact ignore contract

**Choice:** Prepare-written checkpoints stay under `repoDir` (today's
`FACTORY_RELEASE_ROOT_REL`) and join `ARTIFACT_CONTRACT` the same way
`frg/` did. This repo `.gitignore` and the managed ignore block list
that path. Drift-guard fails if the entry is missing.

**Why not move checkpoints to state home now:** checkpoint identity is
already keyed by repo + request fingerprint under `repoDir`. Relocating
it is a larger durable-state migration and is not required to keep
porcelain clean.

**Why not ignore only after the 1.39.13 filename:** the class is every
prepare-written file under `factory-release/`, not one request JSON.

### 3. Composer dest tests lock off-repo writers; they do not become a second gate

**Choice:** Tugboat and in-engine ship already write off-repo. Tests
inspect dest formula (source / helper output) and fail if dest
`relative()` to `REPO_DIR` is inside the checkout. Prepare's admission
gate remains the last-line defense when an operator passes an arbitrary
path.

**Why not have Tugboat also call the Node helper:** Tugboat is shell.
Duplicating realpath logic there is a second implementation. The dest
constant `$RUN_DIR/factory-release-prepare-request.json` plus the
prepare gate is enough.

## Risks / Trade-offs

- **[Risk] Existing operator scripts pass `--request` inside the checkout.**
  → Mitigation: **BREAKING** is explicit. Error names the dest to use.
  Tugboat / in-engine ship already comply.

- **[Risk] Symlink / `..` paths bypass a naive prefix check.**
  → Mitigation: resolve then containment (`path.relative` must not start
  with `..` and must not be absolute). Realpath when the path exists.

- **[Risk] Ignoring `factory-release/` hides a file an operator meant to commit.**
  → Mitigation: those files are restart checkpoints, same class as
  `runs/` and `frg/`. They MUST NOT be committed on the protected
  checkout.

- **[Risk] A future engine-written `.agent-pipeline/<newdir>/` repeats this.**
  → Mitigation: existing drift-guard: every engine-written artifact
  directory needs a contract entry. `factory-release/` joining the
  contract is that law applied, not a one-off ignore line.

## Migration Plan

- Land the gate, ignore-contract entry, tests, and runbook in one change.
- Operators with an in-checkout request move it to `$TMPDIR` or state
  dir and re-invoke the same JSON. No request-schema change.
- Rollback: revert the change. Old prepare accepts in-checkout paths
  again; `factory-release/` becomes unignored porcelain.

## Open Questions

None. Defect token name (`request_inside_checkout`) and ignore vs
relocate for checkpoints are decided above.
