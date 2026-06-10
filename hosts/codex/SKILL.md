---
name: pipeline
description: |
  Use this skill whenever the user wants to advance a GitHub issue or PR
  through a label-driven dev pipeline toward `pipeline:ready-to-deploy`.
  Triggers include phrases like "pipeline issue 419", "push #360 forward",
  "advance this PR through review", "run the pipeline on an issue", `$pipeline`,
  or the legacy `/pipeline` command. Do NOT use this skill for: general PR review,
  backlog triage/cleanup (use $sweep), or deploying a finished item.
---

# Pipeline

This skill keeps the old `/pipeline` workflow as Codex skill `$pipeline`.
Treat the text after `$pipeline`, `/pipeline`, or the natural-language request as the argument string.

Self-contained TypeScript skill that advances a GitHub issue (or PR's linked
issue) through an 11-stage label-driven state machine, ending at
`pipeline:ready-to-deploy`. The pipeline does NOT auto-merge — the user owns
the merge button.

## State machine

```
backlog → ready → planning → implementing
              → review-1 → fix-1 → review-2 → fix-2
              → pre-merge → eval-gate → ready-to-deploy
```

Each item carries one `pipeline:<stage>` label and at most one `blocked`
label. Stage transitions are driven by structured outcomes from the stage
handlers in `scripts/stages/`. The skill **owns** the labels — it sets,
removes, and transitions them as side-effects of running the underlying
stage logic. There is no separate orchestrator process.

`backlog` is a triage marker (e.g. set by `$sweep`). `$pipeline` starts work
at `ready` and only acts on items that already carry a `pipeline:*` label.

## Modes

```
$pipeline N                              advance loop (default; up to 12 transitions)
$pipeline N --status                     read-only; print stage, blocker, PR, last review
$pipeline N --unblock "answer"           post answer and clear blocked label
$pipeline N --once                       advance one stage and stop
$pipeline N --dry-run                    log what would happen; no harness calls, no GitHub writes
$pipeline N --domain d                   override domain name in lock/log paths
$pipeline N --base branch                override base branch
$pipeline N --repo-path path             target a different repo working tree
$pipeline --cleanup                      sweep merged-PR worktrees, then exit (no number)
$pipeline --init                         ensure labels + scaffold .github/pipeline.yml, then exit (no number)
```

The number is auto-detected as an issue or PR via the GitHub API. PRs are
resolved to their linked closing issue (the pipeline is issue-centric). PRs
without a `Closes #N` reference are refused with an explanation.

`--cleanup` is the one mode that takes no number. It sweeps pipeline-managed
worktrees under `worktree_root` whose PR is already merged, removing the worktree
and deleting its local branch (the remote branch is never touched). It only
considers `pipeline/<N>-<slug>` worktrees, and skips — reporting the reason — any
that have uncommitted changes or a local HEAD that differs from the merged PR's
commit. It is idempotent and prints a removed/skipped summary before exiting.

`--init` also takes no number. It onboards a fresh repo in one step: ensures all
pipeline labels via `ensurePipelineLabels` and scaffolds a commented
`.github/pipeline.yml` with every key at its default (skipping the write, with a
notice, if the file already exists). It is idempotent and additive — a normal
`$pipeline N` run still self-creates any missing labels, so `init` is a
convenience, not a precondition.

## Setup (zero install after first run)

The skill is a Node 24+ TypeScript codebase under
`~/.codex/skills/pipeline/core/scripts/`, run via native type-stripping (no
build step). First-ever invocation runs `npm install` automatically.

Required:
- `gh` CLI authenticated against the target repo
- `codex` CLI on PATH for planning, implementation, and fix
- `claude` CLI on PATH and authenticated — the reviewer harness (`prompt-harness` mode
  invokes it directly with a JSON-returning prompt, so **no review plugin is required**)
- Node 24+
- The skill never reads `ANTHROPIC_API_KEY`

Harness ownership is relative to the tool that invoked the pipeline. In the Codex skill, Codex is primary and Claude Code is secondary: Codex owns planning, implementation (documentation updates included, when `steps.docs` is on), and fixes; Claude Code owns review/adversarial review.

## Per-repo config

A repo can opt-in to overrides by committing `.github/pipeline.yml`:

```yaml
base_branch: main                # default 'main'
worktree_root: .worktrees        # relative to repo root
max_concurrent_worktrees: 5
auto_recovery_max_retries: 2
implementation_timeout: 1200     # seconds
review_timeout: 1200
fix_timeout: 1200
ci_timeout: 900
ci_poll_interval: 30
models:
  planning: sonnet
  review: opus
  fix: sonnet
conventions_md_path: CLAUDE.md   # excerpt embedded in prompts
domain_name: lyric-utils
domain_description: a quantitative finance Python library
```

If absent, defaults from `core/scripts/types.ts:DEFAULT_CONFIG` apply. Harness roles come from the install profile — a `harnesses:` key in `.github/pipeline.yml` is rejected at config-parse time, so repo config cannot invert a Codex-invoked pipeline run.

## Run flow

For every invocation:

### 1. Resolve target
1. The numeric arg is fed to `gh api /repos/{repo}/issues/{N}` to detect
   issue vs PR. PRs follow the `closingIssuesReferences` link.
2. Refuse PRs without a closing reference.

### 2. Pre-flight checks
- **Kill switch** at `/tmp/pipeline-{domain}.disabled` — if present, exit.
- **Lock** at `/tmp/pipeline-{domain}.lock` — PID-based, auto-recovers stale.
- **Pipeline label gate** — refuses items without any `pipeline:*` label
  with a message explaining how to opt in (`pipeline:ready` manually).

### 3. Advance loop

```
while iter < 12 and not at ready-to-deploy and not blocked:
  read current stage from labels
  dispatch to the stage handler (planning, review, fix, pre_merge, …)
  print one-line transition
  if --once: break
```

Each iteration may block for up to ~20 minutes. Heavy implementation stages run
Codex against the full repo; review stages invoke the `claude` CLI directly with
the pipeline's JSON-returning review prompt. Worst-case full path is
9 transitions, ~2 hours.

### 4. Orchestration pattern (Codex-side, for default-mode advance)

A foreground command may run longer than normal interactive command windows,
especially when a planning/review/fix stage invokes a harness for up to about
20 minutes. For default advance mode, Codex must orchestrate the run as follows:

#### a. Status pre-check (fast, synchronous)

```bash
node ~/.codex/skills/pipeline/scripts/pipeline.mjs <N> --status
```

Confirms target exists, has a `pipeline:*` label, isn't already at a
terminal/blocked state. If anything looks wrong, surface it and stop —
do not start an advance.

#### b. Start the advance in a PTY session with logging

```bash
cd <repo_dir>
node ~/.codex/skills/pipeline/scripts/pipeline.mjs <N> \
  > /tmp/pipeline-<domain>-<N>.log 2>&1
```

Run with `exec_command` using `tty: true` and a long enough yield window to
capture the session id. Keep the session open until the pipeline exits. Do not
leave a live pipeline session running when the Codex turn ends.

#### c. Poll stage transitions from the session or log

Poll the PTY session with `write_stdin` and summarize material `[pipeline]`
lines to the user. If the session output is too noisy, filter the log.
The **log path** always uses the original argument `<N>` from section b
(the same file that was opened for writing). The **grep filter** uses the
**resolved issue number** `<resolved-N>` — identical to `<N>` when you
passed an issue directly; check the log for
`[pipeline] #<N> is a PR → resolved to issue #<resolved-N>` when you
passed a PR:

```bash
tail -f /tmp/pipeline-<domain>-<N>.log | grep -E --line-buffered \
  "^\[pipeline\] #<resolved-N>: "
```

For example, `/pipeline 64` (issue passed directly, `<N>` = `<resolved-N>` = 64):
```bash
tail -f /tmp/pipeline-<domain>-64.log | grep -E --line-buffered \
  "^\[pipeline\] #64: "
```

`/pipeline 100` where PR 100 resolves to issue 64 (`<N>` = 100, `<resolved-N>` = 64):
```bash
tail -f /tmp/pipeline-<domain>-100.log | grep -E --line-buffered \
  "^\[pipeline\] #64: "
```

**Why the tight filter?** The test-gate stage (`npm test` / `npm run ci`)
dumps the full unit-test suite output to the same log. The eval-gate and
state-machine test fixtures reproduce exact `[pipeline] #<other-N>:` and
`→ ready-to-deploy` substrings (they assert on the pipeline's own log
format). The broad alternation matched hundreds of these fixture lines in
rapid succession, triggering the Monitor tool's auto-stop threshold and
silencing the rest of the run.

**No real signal is lost:** every stage transition — including
`[pipeline] #N: done`, `[pipeline] #N: at <stage> — blocked: …`, and
`[pipeline] #N: → ready-to-deploy` — begins with `[pipeline] #N:`.
The PTY session finishing signals run-end independently.

#### d. User-visible progress updates

For every material `[pipeline]` line, send a concise chat update. The state
machine has only 9 transitions max and each emits a small number of visible
`[pipeline]` lines, so this gives enough signal without flooding the user.

Examples that should be surfaced:
- `[pipeline] #N: starting at stage=<x>`
- `[pipeline] #N: planning (impl=codex)`
- `[pipeline] #N: worktree at <path>`
- `[pipeline] #N: implementation done (Xs, harness=Y)`
- `[pipeline] #N: PR #M created`
- `[pipeline] #N: ready → review-1: PR #M opened`
- `[pipeline] #N: review-1 by claude`
- `[pipeline] #N: verdict=approve findings=0`
- `[pipeline] #N: review-1 → review-2: standard review approved`
- … and so on, all the way through `→ ready-to-deploy`

Examples to suppress or summarize:
- **Repeated polling-loop sub-events** — `pre_merge.advancePolling`
  re-enters the gate check every `ci_poll_interval` seconds (default 30s)
  and emits `[pipeline] #N: pre-merge gate` each time. Surface the FIRST
  occurrence per stage entry; suppress subsequent identical lines in the
  same polling burst. The next material event is the eventual
  `→ ready-to-deploy` or `→ blocked` transition.

#### e. Finish the session

When the pipeline process exits, stop polling and surface the final summary
inline by reading the tail of the log.

#### f. Final summary

Read the last 30 lines of `/tmp/pipeline-<domain>-<N>.log` (same path as
section b — the original argument) and surface inline: starting stage →
ending stage, transitions made, wall-clock elapsed, PR URL if one was
opened, and the terminal state.

### 5. Modes that DON'T need this orchestration

- `--status` — read-only, completes in seconds
- `--unblock "<answer>"` — one comment + label clear, completes in seconds
- `--dry-run` — logs what would happen, no harness calls
- `--cleanup` — sweeps merged-PR worktrees, prints a summary, completes in seconds
- `--init` — ensures labels + scaffolds `.github/pipeline.yml`, completes in seconds

Run those synchronously without the PTY/log-polling orchestration.

`--once` still needs the orchestration because a single heavy stage
(planning especially) can hit its 20-minute timeout. Use the same PTY/log
polling pattern as default mode; just expect at most one transition before the
run exits.

### 6. Optional HTML report artifact

For multi-stage runs, blocked runs with substantial context, or any run whose final state is easier to understand visually, generate a self-contained HTML report in `artifacts/reports/pipeline-<N>.html` inside the target repo/worktree. Keep the chat summary short and include the artifact path.

The report should include:
- stage timeline
- issue/PR links
- branch and worktree path
- changed files
- review findings
- CI/check status
- blockers or terminal state

HTML report constraints: inline CSS/SVG/JS only; no external scripts, stylesheets, CDNs, tracking, network calls, or remote assets. If the report includes interactive controls, include a copy/export block that serializes the selected state back to Markdown/JSON/prompt text.

Do not create HTML for simple `$pipeline N --status`, `--dry-run`, or one-step summaries unless the user asks.

### 7. Final summary

When the loop ends, the skill prints:
- Starting stage → ending stage
- Number of transitions
- Wall-clock elapsed
- For terminal: PR URL + ready-to-deploy summary
- For blocked: latest blocker comment + the unblock command
- For waiting: short reason + "re-run $pipeline N when ready"

## Failure modes

- **`gh` not authenticated** → tell user `gh auth login`, exit.
- **No git repo at cwd / repo-path** → exit 2 with "run from inside a checkout".
- **Issue # doesn't exist** → surface `gh` error, exit 1.
- **PR has no linked issue** → refuse with the explanation.
- **No `pipeline:*` label** → refuse with opt-in instructions.
- **Stage handler error** → posts a `blocked` label + structured comment
  with reason; loop terminates and shows the latest blocker.
- **Codex implementation fails (planning/implementation/fix)** → blocked.

## What this skill never does

- Auto-merge PRs — there is no merge stage, no merge command, and no `auto_merge` config key.
- Bypass the `pipeline:*` opt-in label gate.
- Run more than one transition under `--once`.
- Touch the GitHub repo in `--dry-run` mode.
- Read or send `ANTHROPIC_API_KEY`.
- Write outside the repo's worktree directory or the target issue/PR.

## Reference

- `core/scripts/types.ts` — STAGES, PipelineConfig, Outcome, ReviewVerdict
- `core/scripts/config.ts` — load `.github/pipeline.yml` + defaults
- `core/scripts/gh.ts` — typed wrappers for the `gh` CLI
- `core/scripts/worktree.ts` — `pipeline-{N}-{slug}` worktree lifecycle
- `core/scripts/harness.ts` — invokes Codex for implementation and provides shared process helpers
- `core/scripts/stages/review.ts` — invokes the `claude` CLI directly with the pipeline's JSON-returning review prompt
- `core/scripts/lock.ts` — PID-based lock at `/tmp/pipeline-{domain}.lock`
- `core/scripts/stages/*.ts` — one file per stage (planning, review, fix, pre_merge, eval, deploy_ready, auto_recover)
- `core/scripts/prompts/*.md` — prompt templates with `{{placeholders}}`
- `core/scripts/pipeline.ts` — top-level orchestrator + CLI
- `README.md` — human-facing docs
