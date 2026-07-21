---
name: pipeline
description: |
  Use this skill whenever the user wants to advance a GitHub issue or PR
  through a label-driven dev pipeline toward `pipeline:ready-to-deploy`.
  Triggers include phrases like "pipeline issue 419", "push #360 forward",
  "advance this PR through review", "run the pipeline on <issue>", or the
  `/pipeline` slash command. Do NOT use this skill for: general PR review
  (use /review), backlog triage/cleanup (use /sweep), or deploying a finished
  item (deployment is out of scope — the pipeline stops at ready-to-deploy).
---

# pipeline

Self-contained TypeScript skill that advances a GitHub issue (or PR's linked
issue) through a 13-stage label-driven state machine, ending at
`pipeline:ready-to-deploy`. The pipeline does NOT auto-merge — the user owns
the merge button.

## Developing this skill itself (core/ → plugin/ mirror)

When the work target is the agent-pipeline repo — any implementation, fix, or
test-fix step that edits a file under `core/` — `plugin/` is a generated mirror
of `core/` (+ `hosts/claude`). After editing any file under `core/`, run
`node scripts/build.mjs` from the repo root and include the regenerated
`plugin/` in the same commit. A core-only commit fails CI's
`build.mjs --check` gate and burns a fix-loop attempt on the stale mirror.

## State machine

```
backlog → ready → planning → implementing
              → review-1 → fix-1 → review-2 → fix-2
              → pre-merge → eval-gate → shipcheck-gate → ready-to-deploy
```

Each item carries one `pipeline:<stage>` label and at most one `blocked`
label. Stage transitions are driven by structured outcomes from the stage
handlers in `scripts/stages/`. The skill **owns** the labels — it sets,
removes, and transitions them as side-effects of running the underlying
stage logic. There is no separate orchestrator process.

`backlog` is a triage marker (e.g. set by `/sweep`). `/pipeline` starts work
at `ready` and only acts on items that already carry a `pipeline:*` label.

## Modes

The primary invocation is the advance loop; all other operations are available as
distinct `pipeline:<command>` entries in the skill/command menu.

```
/pipeline N                              advance loop (default; up to 12 transitions)
/pipeline N --once                       advance one stage and stop
/pipeline N --dry-run                    log what would happen; no harness calls, no GitHub writes
/pipeline N --domain <d>                 override domain name in lock/log paths
/pipeline N --base <branch>              override base branch
/pipeline N --repo-path <path>           target a different repo working tree
/pipeline N --detach                     run the advance loop in a detached background process

/pipeline:status <N>                     read-only — print stage, blocker, PR, last review
/pipeline:unblock <N> "<answer>"         post answer + clear blocked label
/pipeline:override <N> "<key>: <reason>" disposition a review finding and auto-resume the advance loop
/pipeline:summary <N>                    print the run's evidence bundle for issue N (local, offline)
/pipeline:doctor                         deterministic preflight check; print summary, exit 0/1
/pipeline N --doctor                     run the preflight before advancing; abort the run on any failure
/pipeline:init                           ensure labels + scaffold .github/pipeline.yml
/pipeline:cleanup                        sweep merged-PR worktrees
/pipeline:intake [--description "<text>"]  spec a rough description into a GitHub issue + ROADMAP PR
/pipeline:intake --description "<text>" --dry-run  preview only; no writes
/pipeline:triage <N> --stage ready       set pipeline:ready on issue N; remove any other pipeline:* stage label
/pipeline:triage <N> --stage backlog     set pipeline:backlog on issue N; idempotent, no model call
/pipeline:sweep                          batch re-spec thin issues + reconcile ROADMAP.md (dry-run)
/pipeline:sweep --apply                  same, applying issue body updates and opening a ROADMAP PR
/pipeline:sweep --apply --repo other/r   sweep a different repository
/pipeline backfill                       preview OpenSpec coverage for legacy behavior (non-mutating)
/pipeline backfill --apply               author a spec-only PR for missing-coverage behaviors
/pipeline backfill --apply --capability auth  scope the apply slice to a named capability
/pipeline:roadmap                        analyze open backlog → dependency-aware scored roadmap (dry-run)
/pipeline:roadmap --apply                same, applying hygiene write-backs + opening a roadmap.md PR
/pipeline:roadmap --next <N>             read existing plan.json, emit top-N dependency-safe issues (no re-run)
/pipeline:merge <pr>                     human-only squash merge of a ready-to-deploy PR (never called by the advance loop)
/pipeline:release <version>              prepare a release PR for the given version
/pipeline:logs [<run-id>] [-f]           list or stream pipeline run logs
/pipeline summary <run-id>               print evidence bundle for an exact run (domain-independent, no issue number)
/pipeline scoreboard                     print read-only factory throughput/cost/reliability metrics from run artifacts
/pipeline config sync [--apply]          preview/apply a safe .github/pipeline.yml scaffold refresh
/pipeline config repo-map <add|remove|list>  add/remove/list repo_map entries in .github/pipeline.yml
/pipeline refine-spec --title "<t>" --body "<b>"  refine existing issue spec; non-mutating JSON output
/pipeline queue                          batch factory: dispatch all pipeline:ready issues up to limits
/pipeline --version                      print the package version, then exit (no number; -V alias)
```

**Deprecated flag forms** (still work, emit a one-line deprecation notice to stderr):
```
/pipeline N --status        → use /pipeline:status N
/pipeline N --summary       → use /pipeline:summary N
/pipeline N --unblock "…"   → use /pipeline:unblock N "…"
/pipeline N --override "…"  → use /pipeline:override N "…"
/pipeline --init            → use /pipeline:init
/pipeline --cleanup         → use /pipeline:cleanup
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
pipeline labels via `ensurePipelineLabels`, scaffolds a commented
`.github/pipeline.yml` with every key at its default (skipping the write, with a
notice, if the file already exists), and ensures a sentinel-delimited
engine-managed block in `.gitignore` covering every local-only artifact
directory the engine writes — `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`,
and `.agent-pipeline/history/`. The `.gitignore` step creates the file if absent,
appends the block if missing (preserving every pre-existing byte), or refreshes
only the block's contents when it is present and stale. It is idempotent and
additive — a normal `/pipeline N` run still self-creates any missing labels, so
`init` is a convenience, not a precondition.

`config sync` also takes no number. It refreshes an existing
`.github/pipeline.yml` against the current init scaffold while preserving
effective configured behavior. Preview is the default and prints a diff without
writing; `--apply` writes only after the existing file and rendered candidate
both validate.

`config repo-map <add|remove|list>` also takes no number. `add`/`remove` mutate
only the `repo_map` block of `.github/pipeline.yml` (all other keys, comments,
and formatting are preserved), creating the block when absent; `add` is
idempotent and `remove` tolerates an absent entry (exit 0, warning). `--rel`
selects `depends_on` (default) or `depended_on_by`. `list` prints current
entries grouped by relationship kind.

`doctor` takes no number either. It runs a **deterministic, model-free** preflight
that checks required CLIs (`gh`, `node`), GitHub auth + repo access, worktree
cleanliness on protected branches, configured harness availability, npm install
freshness, whether the installed engine version is behind the latest
agent-pipeline release, and — when configured — the `openspec` CLI and the eval
command's binary. It prints a per-check pass/fail/warn summary with one-line
remediation on each failure or warning and exits `0` (all pass or warn) / `1`
(any fail). A stale install (`install:version-freshness`) only **warns** — it
never fails the preflight; run `npx github:accidental-hedge-fund/agent-pipeline
update` to refresh it. Opt in to run the preflight at the start of a real run
with `doctor.runOnStart: true` or `--doctor`: a failing check aborts **before
planning**, so no tokens are spent, while a warning prints but does not abort.
`--fail-fast` (or `doctor.failFast: true`) stops at the first failure. The
latest result is stored under `/tmp` and surfaced by `--status`.

`intake` turns a rough one-line description into a decision-complete GitHub issue
**and** a matching `ROADMAP.md` update — in one command:

```bash
/pipeline intake --description "add retry logic to the fix loop"
/pipeline intake "add retry logic" --release v1.6.0
/pipeline intake --description "add retry logic" --dry-run   # preview only
```

The spec-generation step is the only model call; issue creation and roadmap editing
are deterministic. The roadmap update is opened as a PR for human review — the
pipeline never merges. `--release vX.Y.Z` pins the target slot; omitting it
proposes the first open lane from `ROADMAP.md`.

`refine-spec` is a **non-mutating** spec-refinement preview command. It accepts
an existing issue's title and body and returns a refined spec as JSON — no GitHub
writes, no git writes, no filesystem writes:

```bash
/pipeline refine-spec --title "Add retry logic" --body "## Summary\nA retry mechanism."
# → {"title":"...","body":"## Summary\n...","milestone":null}

pipeline refine-spec --help   # probe: exits 0 only on installs that support this contract
```

The output object always contains `title` (string), `body` (string), and `milestone`
(string or null). The `body` field follows the WHAT-not-HOW section contract: Summary,
User story, Acceptance criteria, Out of scope, and Open questions only when genuinely
ambiguous. `--json` is accepted for callers that pass it; behavior is identical (output
is always JSON). Re-running on the same input leaves all repo and GitHub state unchanged.

`triage` sets a pre-pipeline stage label on an issue — no model call, fully
deterministic:

```bash
/pipeline triage 42 --stage ready     # promote to pipeline:ready
/pipeline triage 42 --stage backlog   # move back to pipeline:backlog
```

Only `ready` and `backlog` are settable via `triage`. The command is idempotent
(re-running when already set is a no-op). Mid-flight stages owned by the advance
state machine are rejected with a clear error.

`sweep` is the **batch** companion to `intake`: it re-specs every thin issue in
the existing backlog and reconciles `ROADMAP.md` in one pass:

```bash
/pipeline sweep                  # preview what would change (no writes)
/pipeline sweep --apply          # apply: update issues + open ROADMAP PR
/pipeline sweep --apply --repo owner/repo   # target a different repo
```

Default is preview-only (dry-run). With `--apply`: thin issue bodies are updated
in place; the ROADMAP reconciliation is delivered as a branch + PR for human
review (never committed directly to the default branch). Re-running sweep is
idempotent — already-specced issues are recognized as sufficient and skipped.

`backfill` is a safe maintenance flow for adding OpenSpec coverage to repositories
whose accepted behavior predates OpenSpec adoption. It classifies legacy behaviors
into four groups and optionally opens a spec-only PR for the missing-coverage slice:

```bash
/pipeline backfill                        # preview: four-group coverage report (no writes)
/pipeline backfill --apply                # apply: open a spec-only PR for missing behaviors
/pipeline backfill --apply --capability auth  # scope the slice to a named capability
```

Default is non-mutating preview. With `--apply`: authors an OpenSpec change with
additive requirement deltas, validates with `openspec validate`, and opens a
spec-only PR. Never commits directly to the default branch; never merges.
The diff is asserted to touch only paths under `openspec/` before the PR is created.
Re-running after a slice lands is idempotent — applied requirements are recognized
as already-covered and not duplicated.

## Setup (zero install after first run)

The skill is a Node 24+ TypeScript codebase under
`${CLAUDE_PLUGIN_ROOT}/skills/pipeline/core/scripts/`, run via native type-stripping (no
build step). First-ever invocation runs `npm install` automatically.

Required:
- `gh` CLI authenticated against the target repo
- `claude` CLI on PATH — the primary harness (planning, implementation, fixes)
- `codex` CLI on PATH and authenticated — the reviewer harness (`prompt-harness` mode
  invokes it directly with a JSON-returning prompt, so **no review plugin is required**)
- Node 24+
- The user's Claude Code subscription provides the LLM budget — this skill
  never reads `ANTHROPIC_API_KEY`

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
models:                          # planning/implementing/fix (implementer harness) are only
  planning: sonnet               # honored by claude — a key whose role runs on codex is
  implementing: sonnet           # ignored and a config warning is printed. review (reviewer
  review: claude-fable-5         # harness) is honored by both claude and codex. Each key also accepts "auto".
  fix: sonnet
effort:                          # per-phase reasoning effort — codex via -c model_reasoning_effort,
  planning: medium               # claude via --effort. Absent key: no flag. Each key also accepts "auto".
  implementing: low              # planning also sources plan-review's effort (classified separately).
  review: high                   # review is resolved round-aware (review-1 vs. review-2).
  fix: low
conventions_md_path: CLAUDE.md   # excerpt embedded in prompts
domain_name: lyric-utils
domain_description: a quantitative finance Python library
```

If absent, defaults from `core/scripts/types.ts:DEFAULT_CONFIG` apply. The Claude-side pipeline is harness-relative: Claude Code is always primary for planning, implementation (documentation updates included, when `steps.docs` is on), and fixes; Codex is always secondary for review/adversarial review. Harness roles come from the install profile — a `harnesses:` key in `.github/pipeline.yml` is rejected at config-parse time, so repo config cannot invert a Claude-invoked pipeline run. The reviewer harness MAY be overridden via the optional `review_harness` key:

```yaml
review_harness: my-reviewer   # use a custom CLI as the reviewer instead of the profile default
```

When `review_harness` is set, the pipeline spawns `<value> "<prompt>"` and expects a JSON verdict on stdout (same schema as the built-in reviewers). If the CLI cannot be spawned, the item is blocked with an error naming the CLI explicitly, and the implementing harness is tried as a self-review fallback (established by #39). The `harnesses.implementer` is never overridable by repo config.

`review_harness` also accepts a structured form for independent reviewer model/effort control, each accepting `"auto"` (resolved round-aware — plan-review/review-2 as Definitive, review-1 as Iterative):

```yaml
review_harness:
  command: claude
  model: auto
  effort: auto
```

### External stage executors (#314)

Beyond `review_harness` (which only overrides the reviewer CLI), any model-invoking
stage — `planning`, `implementing`, `review-1`, `review-2`, `fix-1`, `fix-2`,
`plan-review`, and `shipcheck-gate` when enabled — can be delegated to an **external
agent system** (OpenCode, HermesAgent, OpenClaw, or any other API-driven execution
backend) or, for review-only stages, to a raw **model endpoint** (e.g. a local Ollama
server). This is entirely opt-in: a repo with no `executors:`/`stage_executors:`
block behaves exactly as today.

```yaml
executors:
  opencode-main:
    type: agent-system              # full execution backend — valid for ANY model-invoking stage
    provider: opencode               # provider identifier (a plain string; not a built-in adapter)
    endpoint: https://opencode.internal/api
    credential: OPENCODE_API_KEY     # env-var NAME resolved at invocation time — never a literal value
  local-ollama:
    type: model-endpoint             # raw OpenAI-compatible chat/completions endpoint
    base_url: http://localhost:11434/v1
    model: llama3.1:70b
    # no credential needed for a localhost endpoint

stage_executors:
  planning: opencode-main
  review-1: local-ollama
  review-2: local-ollama
```

Key rules:

- **`agent-system`** executors may be assigned to any model-invoking stage. The
  pipeline `POST`s `{ stage, prompt }` to `endpoint` (with an `authorization: Bearer
  <credential>` header when `credential` is set) and expects `{ "output": "<text>" }`
  back; that text flows through the exact same downstream parsing (including
  `parseStructuredVerdict` for review stages) as a local CLI's stdout.
- **`model-endpoint`** executors are valid **only** for the prompt-contained stages
  `plan-review`, `review-1`, `review-2` — a raw endpoint has no repo/tool access, and
  these are the only stages whose prompt already carries all the context needed
  (diff, plan text, conventions excerpt) inline. Assigning one to `planning`,
  `implementing`, `fix-1`, `fix-2`, or `shipcheck-gate` is rejected **at
  config-parse time**, naming both the offending stage and executor — never
  discovered mid-run.
- Credentials are **references** (an env-var name), resolved from the environment
  only at invocation time; the value is never written to `pipeline.yml` or emitted
  in run evidence.
- A misconfigured, unreachable, or non-compliant executor **blocks the item** with
  an error naming the stage and provider — there is no silent fallback to the local
  `claude`/`codex` harness (this is distinct from, and takes priority over, the
  `review_harness` self-review fallback above, which never applies to a
  `stage_executors` assignment).
- Run evidence records which executor (and, for `model-endpoint`, which model)
  ran each delegated stage.
## Conventions & carry-forward lessons

`readConventions` reads the target repo's conventions file (`conventions_md_path`, else `CLAUDE.md` on this host) and injects an excerpt into **every** stage prompt — planning, plan-review, plan-revision, implementing, both review rounds, and both fix rounds — via the `{{conventions}}` placeholder. This makes the conventions file the natural home for **carry-forward lessons**: a maintainer-curated `## Lessons / Gotchas` section (or a dedicated lessons file pointed at by `conventions_md_path`) recording recurring findings and repo-specific hazards. It is ordinary conventions text, so it rides the existing injection with **no extra config key, store, or flag** beyond the `conventions_md_path` / `CLAUDE.md` default.

The contract is **read-only**: no stage ever writes to, appends to, or creates the conventions file — the maintainer curates the lessons by hand and the pipeline carries them forward. A repo with no conventions file is unaffected (`readConventions` returns a benign stub and every stage proceeds).

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

Each iteration may block for up to ~20 minutes (heavy stages run
implementer/reviewer harnesses against the full repo). Worst-case full
path is 9 transitions, ~2 hours.

### 4. Orchestration pattern (Claude-side, for default-mode advance)

A foreground bash invocation will be killed at the harness's 10-minute
timeout — long before a planning stage finishes (~20 min cap each).
For the default advance mode, Claude **must** orchestrate the run as
follows:

#### a. Status pre-check (fast, synchronous)

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs <N> --status
```

Confirms target exists, has a `pipeline:*` label, isn't already at a
terminal/blocked state. If anything looks wrong, surface it and stop —
do not start an advance.

#### b. Launch the advance through detached run-store mode

```bash
cd <repo_dir>
RUN_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs run <N> --detach)
cat "$RUN_DIR/run-store.json"
```

This command returns quickly. `RUN_DIR` is a supervision wrapper under
`~/.pipeline/runs/...`; `run-store.json` points at the canonical
`.agent-pipeline/runs/<run-id>/` run store. Use that `run_store_run_id` for all
log and summary commands below.

#### c. Stream structured run events via Monitor

Arm a persistent Monitor on the run-store event stream:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs logs <run-id> --events --follow
```

`--events` follows `.agent-pipeline/runs/<run-id>/events.jsonl`, the canonical
structured stream for lifecycle, gate, blocker, PR, review, accounting, and
completion events. It is not a grep-filtered terminal log and it is not a
separate `/tmp` transitions artifact.

Set `persistent: true`, `timeout_ms: 3600000` (1 hour — re-arm if
needed). Each emitted line lands in Claude's notification stream.

**Fallback — raw terminal output:** If you need the full combined output
(harness prose, CI stdout, stage output), follow `terminal.log` from the same
run store:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs logs <run-id> --follow
```

Do not create or recommend extra `/tmp/pipeline-<domain>-<N>.log` files for
normal monitoring. If a human manually redirects output for local debugging,
that file is scratch output, not the pipeline evidence contract.

#### d. Push notification on material event records

For every material Monitor event (see suppression list below), call
`PushNotification` with a short one-line message. The state machine has
only a bounded number of stage transitions, so
this caps at a small number of pushes per full run — coarse enough to not be spammy,
fine enough that the user never wonders "is anything happening?" between
major arrows.

Examples that DO push:
- `run_start`
- `stage_start`
- `stage_complete`
- `pr_created` / `pr_updated`
- `review_verdict`
- `gate_result`
- `blocker_set` / `blocker_cleared`
- `run_complete`

Examples that do NOT push:
- **Repeated polling-loop sub-events** — `pre_merge.advancePolling`
  re-enters the gate check every `ci_poll_interval` seconds (default 30s).
  Push the first material stage/gate event per stage entry; suppress
  subsequent identical polling updates in the same burst. The next material
  event is the eventual advancing or blocked stage outcome.

The "err toward not sending" guidance in the PushNotification docs is
about ambient noise — but `/pipeline N` is a foreground operation the
user explicitly invoked, not background ambient state. They asked for
this push stream; deliver it.

#### e. Stop the Monitor when the run completes

Stop the Monitor when a `run_complete` event appears, or when the wrapper
`$RUN_DIR/sentinel.json` reports completion. Then surface the final summary.

#### f. Final summary

Read the run-store summary and surface inline:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs summary <run-id>
```

Include starting stage, ending stage, transitions made, wall-clock elapsed, PR
URL if one was opened, and the terminal state. Also send one final
PushNotification with the terminal state.

### 5. Modes that DON'T need this orchestration

- `--status` — read-only, completes in seconds
- `--unblock "<answer>"` — one comment + label clear, completes in seconds
- `--dry-run` — logs what would happen, no harness calls
- `--cleanup` — sweeps merged-PR worktrees, prints a summary, completes in seconds
- `--init` — ensures labels + scaffolds `.github/pipeline.yml`, completes in seconds
- `config sync` — previews/applies a validated `.github/pipeline.yml` scaffold refresh, completes in seconds
- `config repo-map <add|remove|list>` — mutates/lists `repo_map` entries, completes in seconds
- `doctor` — deterministic preflight, no model calls, completes in seconds

Run those synchronously, no Monitor, no background, no Push.

`--once` still needs the orchestration because a single heavy stage
(planning especially) can hit its 20-min timeout. Use the same
background + Monitor + Push pattern as default mode; just expect at
most one transition before the run exits.

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

Do not create HTML for simple `/pipeline N --status`, `--dry-run`, or one-step summaries unless the user asks.

### 7. Final summary

When the loop ends, the skill prints:
- Starting stage → ending stage
- Number of transitions
- Wall-clock elapsed
- For terminal: PR URL + ready-to-deploy summary
- For blocked: latest blocker comment + the unblock command
- For waiting: short reason + "re-run /pipeline N when ready"

## Failure modes

- **`gh` not authenticated** → tell user `gh auth login`, exit.
- **No git repo at cwd / repo-path** → exit 2 with "run from inside a checkout".
- **Issue # doesn't exist** → surface `gh` error, exit 1.
- **PR has no linked issue** → refuse with the explanation.
- **No `pipeline:*` label** → refuse with opt-in instructions.
- **Stage handler error** → posts a `blocked` label + structured comment
  with reason; loop terminates and shows the latest blocker.
- **Primary harness fails (planning/implementation/fix)** → blocked unless the stage explicitly defines a safe fallback.

## What this skill never does

- Auto-merge PRs autonomously — the advance loop never merges and there is no `auto_merge` config key. The human-invoked `/pipeline merge <pr>` command is the controlled, explicit surface for merging after `pipeline:ready-to-deploy`; it is never called by the advance loop.
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
- `core/scripts/harness.ts` — `invoke("claude" | "codex", cwd, prompt)` (planning/impl/fix)
- `core/scripts/stages/review.ts` — review-1/review-2 invoke the `codex` CLI directly
  with the pipeline's JSON-returning review prompt
- `core/scripts/lock.ts` — PID-based lock at `/tmp/pipeline-{domain}.lock`
- `core/scripts/stages/*.ts` — one file per stage (planning, review, fix, pre_merge, eval, deploy_ready, auto_recover)
- `core/scripts/prompts/*.md` — prompt templates with `{{placeholders}}`
- `core/scripts/pipeline.ts` — top-level orchestrator + CLI
- `README.md` — human-facing docs
