# Design — visual-gate

## Context

The eval-gate (`core/scripts/stages/eval.ts`, `eval_gate` in `core/scripts/config.ts`) already
implements the exact lifecycle this issue asks for: opt-in per repo, `sh -c` execution in the issue
worktree, exit-code-only verdict, `gate`/`advisory` modes, bounded fix-round recovery (#372),
tooling failures block immediately, tail-biased output excerpts. The visual-gate is deliberately the
same machinery plus one new obligation: an artifact bundle that reaches the human at
`ready-to-deploy`.

## Goals / Non-Goals

**Goals**

- A first-class `visual-gate` stage that matches the README infographic.
- Reviewable visual evidence attached to the issue and the evidence bundle.
- The repo owns all browser/E2E infrastructure and all targeting decisions.

**Non-Goals**

- Pipeline-hosted browsers, Playwright/Cypress installation, or preview-deployment provisioning.
- Screenshot diffing or visual-regression scoring inside the pipeline.
- Any change to eval-gate or shipcheck-gate behavior, or to the rest of the gate-band order.

## Decisions

### 1. Mirror eval-gate rather than generalize it

**Decision:** implement `core/scripts/stages/visual.ts` as a sibling of `eval.ts`, extracting only
what is already trivially shared (tail-biased excerpting, the `runCapped` shell runner, the
fix-round verification seam) instead of refactoring eval-gate into a generic "command gate".

**Why:** a speculative shared abstraction over two gates with different evidence contracts would
broaden the diff far past the issue's scope and put the (hard-won, convergence-critical) eval-fix
routing at risk. If a third command gate ever appears, the generalization can be done then with
three real call sites to design against.

### 2. Position: after `pre-merge`, before `eval-gate`

`STAGES` becomes `… pre-merge, visual-gate, eval-gate, shipcheck-gate, ready-to-deploy`. `pre-merge`
advances to `visual-gate`; a disabled visual-gate transitions immediately to `eval-gate`. This
matches the infographic's `visual-gate → eval-gate` order and keeps the existing band otherwise
untouched.

**Caveat, stated honestly:** the issue's "byte-for-byte unchanged when disabled" criterion cannot be
literally true — a disabled repo now traverses one extra label transition and emits one extra skip
log line, exactly as the eval-gate change did when it landed. The spec encodes the eval-gate
precedent: no comment, no child process, no artifacts, same terminal outcome, one extra skip line.

### 3. Artifacts: declared directory, enumerated by the pipeline, never interpreted

`visual_gate.artifacts_dir` (default `.pipeline-visual`) is a **worktree-relative** path the command
writes into. After each run the stage:

1. resolves `artifacts_dir` against the worktree root and rejects any path that escapes it;
2. enumerates the files it finds (bounded count and total size, deterministic sort order);
3. copies them into `<runDir>/visual/<attempt-N>/` so they survive worktree cleanup;
4. records the relative-path manifest in the `## Visual Gate` comment and the evidence bundle.

**Why not upload images to the PR?** `gh` has no supported attachment-upload API, and inlining
binaries in a comment is not viable. Listing the manifest plus a durable run-directory copy gives
the reviewer a reliable pointer without the pipeline pretending to be an artifact host. Repos that
already publish artifacts (CI upload, preview host) can emit their own URLs from the command output,
which the excerpt carries into the same comment.

**Missing/empty directory is not a failure.** Exit code remains the sole verdict; an absent bundle is
reported as "no artifacts captured" so the gap is visible rather than silently green.

### 4. Run context via environment variables

`runCapped` currently inherits `process.env` with no per-call additions. Add an optional `env`
override to its options and pass `PIPELINE_PR_NUMBER`, `PIPELINE_BRANCH`, `PIPELINE_ISSUE`,
`PIPELINE_RUN_ID`, `PIPELINE_VISUAL_ARTIFACTS_DIR` (absolute). This is the minimum needed for a
repo-defined suite to locate its per-PR preview deployment, and it changes no existing caller's
behavior (absent `env` = today's inheritance).

Secrets stay out of the engine: seeded test credentials are supplied by the operator's own
environment/CI secrets and simply inherited by the command. The README documents that pattern; the
pipeline neither reads nor stores them, and artifact/output excerpts pass through the existing
`redactSecrets` sanitizer before being posted.

### 5. Fix-round contract reuses the eval-gate shape

`gate` mode failure with budget remaining builds a visual-fix prompt naming the gate
(`visual-gate`), the configured command, the tail-biased output excerpt, and the artifact manifest
(paths only — the harness can open them in the worktree). `max_attempts` bounds total command runs,
so fix rounds are at most `max_attempts − 1`; `max_attempts: 1` means block on first failure. A pass
that follows a pushed visual-fix commit routes to `pre-merge`, determined from GitHub PR state (last
reviewed SHA + a commit matching the visual-fix message format) rather than an in-memory flag — the
same durability requirement that #372 established for eval-gate.

## Risks

- **Long-running suites**: browser suites routinely exceed the eval-gate's 300 s default. Default
  `timeout` to 900 s for this gate and document tuning.
- **Artifact volume**: bounded file count/total size with an explicit truncation note in the comment,
  so a runaway trace directory cannot blow up the run directory or the comment.
- **Preview-deployment readiness**: waiting for a preview URL to become live is the repo command's
  responsibility; the pipeline only supplies the PR/branch identifiers.
