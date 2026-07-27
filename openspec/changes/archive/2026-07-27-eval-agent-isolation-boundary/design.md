## Context

`core/scripts/evals/executor.ts` already isolates a cell well along two axes: a fresh worktree at
the fixture's `base_commit` with a cell-unique branch/session identity, and a credential boundary
(`isolatedGhEnv` blanks `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`, redirects `GH_CONFIG_DIR`
and `GIT_CONFIG_GLOBAL` at empty cell-scoped paths, drops `SSH_AUTH_SOCK`, and forces
`GIT_SSH_COMMAND` to an unusable identity). `createEvalGhSurface` refuses every mutating `gh`
operation *made through the injected seam*.

Neither axis addresses what actually went wrong in #607. A local CLI harness is an autonomous agent
with a shell. Inside the cell worktree it can still, using only local operations that need no
credential at all:

- read `AGENTS.md` / `CLAUDE.md` from the checked-out repository and adopt the **project's** workflow
  (which, for this repo, instructs it to create a worktree and drive `/pipeline`);
- `git worktree add` a nested worktree — a purely local operation;
- `git commit` — local, no credential;
- invoke the installed `pipeline` CLI, which advances real stage state via the operator's own
  ambient environment outside the cell's env overrides in some install shapes.

`isolatedGhEnv` deliberately does not redirect `HOME` (the harness CLI's own model credentials live
there), so any tooling the operator has installed remains on `PATH`. The instruction surface and the
command surface are therefore both unguarded, and the observed failure used both.

Separately, whether Codex could run at all depended on the operator exporting
`PIPELINE_CODEX_NO_SANDBOX=1` in their shell. That is an ambient, unrecorded property: two cells in
the same experiment could have been executed under materially different sandbox regimes with
identical `config_hash` values, and the resulting artifacts would look poolable when they are not.

## Goals / Non-Goals

**Goals**
- A local harness cell obeys an eval-specific instruction contract that outranks the repository's
  own workflow documents.
- The high-risk command set is denied at the process boundary, so a treatment that ignores the
  prompt still cannot escape the cell.
- Every denial is durable, attributable evidence, kept out of the correctness signal.
- The execution sandbox regime is a declared, recorded part of the experiment.

**Non-Goals**
- A general-purpose sandbox or a security boundary against a hostile agent. This is an *evaluation
  validity* boundary against a well-intentioned agent following the wrong instructions; the threat
  model is confusion, not malice. A determined agent can call `/usr/bin/git` by absolute path — the
  spec requires that the ordinary path be denied and any denial be recorded, not that escape be
  impossible.
- Changing behaviour for ordinary (non-eval) pipeline runs.
- Re-running the invalidated experiments, or any grader/rubric change.

## Key Decisions

### 1. Install the contract as a root instruction file in the cell worktree, then restore

The failure mode is precisely "the harness read the repo's root instruction file." The fix that
addresses the root cause is to make the file the harness reads say the right thing for the duration
of the cell, rather than layering additional prompt text the harness has already demonstrated it
will subordinate to `AGENTS.md`.

The executor writes the eval contract to each root-instruction path the target harness reads
(`AGENTS.md` for Codex, `CLAUDE.md` for Claude; both are written unconditionally so a harness that
reads either is covered, and so the set does not have to be re-derived per adapter). Prior content
is captured in memory before the write.

*Alternatives rejected.* (a) *Prepend the contract to the materialized stage prompt only* — this is
what already effectively happened, and it lost to `AGENTS.md`. (b) *Delete the repo's instruction
files* — silently changes the repository under test; a fixture whose task legitimately concerns
those files becomes unmeasurable. (c) *An adapter-level system-prompt flag* — not uniformly
available across the adapters this engine drives, so it cannot be the enforcement point.

**Restore is a correctness requirement, not hygiene.** `defaultGetChangedPaths` runs
`git diff --name-only <base_sha>` against the working tree, and `allowed_change_paths` grading
consumes the result. An installed-but-unrestored `AGENTS.md` would be reported as a
treatment-produced out-of-scope change on every cell of every fixture that declares
`allowed_change_paths` — i.e. the boundary would corrupt the very measurement it exists to protect.
Restore therefore happens **before** checks and changed-path collection, and again defensively in
the existing `finally` block (idempotent), following that block's established non-fatal convention:
a restore failure is logged and recorded as boundary evidence, never thrown.

### 2. Enforce via a cell-scoped deny shim prepended to the child's `PATH`

`isolatedGhEnv` already proves the pattern: enforcement belongs at the actual process boundary, not
at a prompt-only convention. The executor creates a cell-scoped shim directory (alongside the
existing `.eval-gh-config-empty` / `.eval-gitconfig-empty` cell-scoped paths) containing executable
interceptors for `gh`, `pipeline`, and `git`, and prepends it to `PATH` in the same env-override
object.

- `gh` — deny every invocation. Reads are already served from the fixture's frozen snapshot; the
  eval surface's read/write split governs the *seam*, and a direct `gh` shell-out has no legitimate
  role in a cell.
- `pipeline` — deny every invocation. There is no advance, queue, or stage command a cell should
  run.
- `git` — deny by subcommand: `worktree`, `commit`, `push`, `remote`, plus their obvious aliases
  (`git -C … commit`); pass everything else through to the real `git` so `status`, `diff`, `log`,
  and `add` continue to work. Read-only and working-tree git is how a harness inspects and edits
  the repo; blanket-denying `git` would make most fixtures unrunnable.

A denied invocation prints a named reason to stderr, exits non-zero, and appends one JSON line to a
cell-scoped denial log inside the worktree (a path excluded from changed-path evidence, like the
contract files). The executor reads that log after the harness returns.

*Why a log file rather than parsing stderr:* the shim is a separate process; the log is the only
channel that survives independently of how the harness buffers, truncates, or swallows child
output, and it keeps the denial record structured instead of regex-recovered.

*Why not deny `git commit` by making the worktree read-only:* the treatment must be able to edit
files — that is the measurement.

**Known limitation, stated rather than papered over:** a `PATH` shim is bypassable by absolute path
or by a shell builtin. That is accepted; the design intent is to deny the ordinary route and to make
any denial visible, which is what turns a silently-invalid cell like `primary-model-screen-20260727b`
into a recorded, classifiable event.

### 3. Boundary denials are evidence, never a correctness signal

A denial is recorded on the cell record in its own field, alongside the `gh` refusals `runCell`
already collects but `run.ts` currently discards. Deliberately:

- it does **not** change `result_class` (`completed` / `infra_error` / `auth_error` / `timeout`
  keep their current meanings — a denial is neither infrastructure breakage nor a timeout);
- no grader reads it. Whether a treatment *tried* to escape the cell is a distinct axis from whether
  its plan/diff/review was correct, and conflating them would make an isolation event look like a
  quality score.

Reporting/analysis consumers can then treat "cells with boundary denials" as a first-class
population — which is exactly the analysis that had to be done by hand for the two invalid
experiments.

### 4. Declared sandbox mode, resolved by the runner, recorded on the cell

The manifest declares the mode (default: the harness's own managed sandbox, i.e. today's
`--full-auto` behaviour for Codex). The runner resolves it and passes it explicitly through
`invoke()` into adapter invocation shaping. The eval path does **not** consult
`PIPELINE_CODEX_NO_SANDBOX`.

The adapter keeps the ambient environment variable as its **fallback** when no caller-supplied mode
is present, so ordinary pipeline runs — and the `cli-harness-adapters` "byte-for-byte, including the
external-sandbox bypass mode" requirement and its golden-argv test — are unaffected. This is a
strictly additive input, not a replacement.

The resolved mode enters the cell's `effectiveConfig` (hence `config_hash`) and is written onto the
cell record. Two cells differing only by sandbox mode therefore hash differently and cannot be
silently pooled.

*Alternative rejected:* a per-treatment axis. Sandbox mode is a property of the *runner's machine*,
not of the model under test; making it an axis would invite a matrix that varies it, which measures
the runner rather than the treatment.

## Risks / Trade-offs

- **Contract restore failure strands a modified worktree.** Mitigated by restoring before grading
  input is collected, by an idempotent second attempt in `finally`, and by recording the failure as
  boundary evidence. The worktree is removed immediately afterwards in the normal path anyway.
- **The shim could break a legitimate fixture** whose task genuinely involves committing. No current
  fixture does; if one is ever needed, the boundary would need a fixture-declared exemption — out of
  scope here, and it should be an explicit, recorded declaration rather than a relaxation of the
  default.
- **Writing files into the cell worktree** slightly widens the executor's filesystem footprint. All
  written paths are cell-scoped and excluded from changed-path evidence, matching the existing
  `.eval-gh-config-empty` precedent.
- **`PATH`-shim bypass** — accepted and documented above.

## Migration

Additive. Existing manifests without a declared sandbox mode keep today's behaviour via the default
(harness-managed). Existing cell records without boundary-evidence fields remain readable; the field
is optional and absent means "no denial recorded", never "collection not attempted" (a collection
failure is recorded explicitly, mirroring `trajectory_artifact_error`).
