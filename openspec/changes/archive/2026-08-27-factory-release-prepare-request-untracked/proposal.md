## Why

`pipeline factory-release prepare --request <path>` accepts any absolute path.
When that path is inside the live control checkout (observed 2026-08-27:
`$REPO_DIR/.agent-pipeline/request-1.39.13.json` for FRG 1.39.13), the
untracked file dirties protected `main`. The Factory Reliability Gate (FRG)
pack loop's first item then runs `pipeline doctor`, fails `worktree-clean`,
and dies with `run_fatal` and `dispatched: 0` before any pack item runs.
Nothing validates request location. Nothing warns that the file dirties
`main`. `.agent-pipeline/` is not fully gitignored: only named contract
subdirs (`runs/`, `frg/`, …) are. A request JSON at the `.agent-pipeline/`
root is porcelain.

**Class vs site (engine-dogfood bar):**

| | |
| --- | --- |
| **Site** | `--request /home/mcomardo/dev/ap-main-control/.agent-pipeline/request-1.39.13.json` on FRG for 1.39.13. Pack loop `loop-68575cf7a09c849c` failed doctor `worktree-clean` and `run_fatal` with `dispatched: 0`. |
| **Class** | Operator-supplied `--request` files and engine-written prepare dispatch artifacts MUST NOT appear as untracked porcelain on a protected checkout. The next identical in-checkout request or unignored prepare scratch MUST fail the same tests. |
| **Shared surfaces** | Prepare request-path containment gate; artifact ignore contract for `.agent-pipeline/factory-release/`; Tugboat / ship-adapter request dest stays off-repo. |
| **Next identical fault** | A later `--request` under `$REPO_DIR`, a later unignored `.agent-pipeline/factory-release/` checkpoint, or a later composer that writes the request into `REPO_DIR` fails the same tests. No new mole issue. |

A path-local gitignore of one `request-*.json`, host-only `skip-worktree`,
or doctor treating that file as engine scratch is not the class fix.

## What Changes

- **Request-path gate.** `factory-release prepare` SHALL reject a `--request`
  path that resolves inside the target checkout (`repoDir`, factory control
  checkout, or the harness target repo being prepared). The error is typed,
  names the path and the checkout, and remediates to `$TMPDIR`,
  `AGENT_PIPELINE_STATE_HOME`, or the Tugboat `$RUN_DIR`.
- **Dispatch artifacts stay off the protected branch.** Prepare-written
  checkpoint / binding files under `.agent-pipeline/factory-release/` SHALL
  join the engine artifact ignore contract (same class as `frg/`). FRG
  scratch stays gitignored per the existing `frg/` contract. Prepare SHALL
  NOT land untracked files on the protected branch at pack-loop dispatch.
- **Composers stay off-repo.** Tugboat already writes
  `$RUN_DIR/factory-release-prepare-request.json`. In-engine ship already
  writes under `AGENT_PIPELINE_STATE_HOME`. Tests SHALL fail if either dest
  resolves inside `REPO_DIR`.
- **Docs / runbook.** Documented `factory-release prepare` invocations place
  `--request` outside the target checkout.

**BREAKING** for operators who pass `--request` inside the target checkout
(for example `$REPO_DIR/.agent-pipeline/request.json`). Those calls fail
with a named error until the file is moved off-repo.

## Acceptance criteria

- [ ] `factory-release prepare --request` with a path that resolves inside
      the target checkout exits non-zero before pack-loop dispatch and
      returns a named defect (path + checkout + off-repo remediation).
- [ ] The same call with an absolute path under `$TMPDIR` or
      `AGENT_PIPELINE_STATE_HOME` is not rejected for location.
- [ ] After a successful in-progress dispatch from an off-repo request,
      `git status --porcelain` on the protected target checkout does not
      list the request file or prepare checkpoint / binding files as
      untracked.
- [ ] Uncommitted `.agent-pipeline/factory-release/` on the factory control
      checkout does not fail doctor `worktree-clean`. Host-only
      `skip-worktree` is not the product fix.
- [ ] A unit test fails if prepare accepts a request inside the target
      checkout, or if prepare leaves the target repo dirty with its own
      artifact.
- [ ] A unit test fails if Tugboat or in-engine ship writes the request
      JSON into `REPO_DIR`.
- [ ] The FRG runbook and prepare help name an off-repo request location
      (`$TMPDIR`, state dir, or Tugboat `$RUN_DIR`) and do not show
      `$REPO_DIR/.agent-pipeline/request.json` as the example dest.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change;
      `openspec validate factory-release-prepare-request-untracked` and
      `npm run ci` pass when implementation lands.

## Capabilities

### New Capabilities

<!-- None. This is class law on existing prepare, ignore, and composer
     surfaces. A new capability folder would hide the class in a mole spec. -->

### Modified Capabilities

- `release-sub-command`: `pipeline factory-release prepare` SHALL reject a
  `--request` path that resolves inside the target checkout, with a named
  error and off-repo remediation, before pack-loop dispatch.
- `engine-artifact-ignore-contract`: The contract and this repo `.gitignore`
  SHALL include `.agent-pipeline/factory-release/`.
- `tugboat-thin-ship`: Tugboat SHALL write the factory-release prepare
  request outside `REPO_DIR` (existing `$RUN_DIR` dest). A test SHALL fail
  if that dest resolves inside the checkout.
- `factory-reliability-gate`: Documented prepare invocations SHALL place
  `--request` outside the target checkout.

## Impact

- **Prepare admission:** `core/scripts/factory-release-prepare.ts`,
  `core/scripts/pipeline.ts` factory-release verb, prepare unit tests.
- **Ignore contract:** `core/scripts/artifact-ignore.ts`, this repo
  `.gitignore`, drift-guard tests.
- **Composers:** `examples/supervisor/shell/tugboat.sh` request dest
  (already `$RUN_DIR`); `core/scripts/stages/ship-adapter.ts` persist dest
  (already state home); composer tests.
- **Docs:** `docs/factory-reliability-gate-runbook.md`, prepare help,
  `docs/runbooks/ship-milestone.md` / CLI reference as needed.
- **Out of scope:** loop `run_fatal` resume (sibling issue); all-integrated
  ship freeze (#1252); non-durable fallback; doctor ignoring in-checkout
  request files; gitignoring `request-*.json` as the product fix.
