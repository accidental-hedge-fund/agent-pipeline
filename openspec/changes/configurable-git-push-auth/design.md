## Context

See `proposal.md` for motivation (false `push-failed` blocks when workflow files meet an HTTPS PAT without `workflow` scope).

Current engine state that shapes the design:

- Managed worktrees inherit the parent repo’s `origin`. Operators typically use SSH (`git@github.com:owner/repo.git`). SSH has no GitHub “workflow scope” concept, so workflow-file pushes succeed when the remote and credentials stay on SSH.
- Deterministic stage pushes (implementing, fix, eval/visual fix rounds, intake/sweep reservations, etc.) invoke `git push` / `git push -u origin <branch>` via helpers such as `pushWithCurrencyCheck` and stage-local `gitPush` deps. They do **not** currently select an explicit auth mechanism beyond ambient git config and credential helpers.
- Model harnesses run in the worktree with full git/gh CLI access. A harness may push during the stage, or ambient `gh auth git-credential` may rewrite or authenticate HTTPS against a classic PAT (`repo`, `read:org`, …) **without** `workflow`. GitHub then rejects updates under `.github/workflows/**`.
- Existing config credential fields (executors, product-fault intake, etc.) store **env-var names / secret references only**, never literal secrets. New push auth MUST match that pattern.
- `pipeline doctor` is the operator-facing preflight surface for auth and environment readiness.

## Goals / Non-Goals

**Goals:**

- Single operator-selected push auth mechanism with default `ssh`.
- One resolution path applied to engine-owned worktree pushes and harness push guidance so HTTPS/`gh` fallback cannot silently diverge from operator intent.
- Clear fail-fast diagnostics when HTTPS-token auth is missing `workflow` scope on workflow-file paths.
- Schema + doctor admission; unit-testable transport selection without real network/git.

**Non-Goals:**

- Implementing a full GitHub App installation-token minting flow (`app`) in this change.
- Changing merge authority, review policy, force-push rules, or currency-check retry policy.
- Storing or logging secret values; embedding tokens in remote URLs written to disk for longer than a push invocation.
- Rewriting every non-worktree git operation in the monorepo (e.g. release tag push on the main checkout) unless it already shares the same managed-worktree push helper — prefer centralizing the worktree push seam first.
- Guaranteeing that a misbehaving model can never invoke raw `git`/`gh` outside guidance; the design makes the configured mechanism the authoritative pipeline path and removes incentive/need for ambient HTTPS fallback on the default SSH path.

## Decisions

### 1. Config surface: nested `git.push_auth` string with mechanism prefixes

**Choice:** Add an optional strict `git` block to `PartialConfigSchema`:

```yaml
git:
  push_auth: ssh                    # default when absent
  # push_auth: https-token:GITHUB_PUSH_TOKEN   # env-var NAME only
```

Resolved config always exposes a structured form, e.g.:

- `{ mechanism: "ssh" }`
- `{ mechanism: "https-token", tokenEnv: "GITHUB_PUSH_TOKEN" }`

Parse rules:

- Absent / empty → `ssh`.
- Exact `ssh` → SSH mechanism.
- `https-token:<ENV_NAME>` where `<ENV_NAME>` matches a conservative env-var name pattern (e.g. `^[A-Za-z_][A-Za-z0-9_]*$`) → HTTPS-token mechanism; store only the name.
- `app` → **rejected at schema/resolve time** in this change with a message that App auth is not implemented yet (reserved for a future change). Avoid accepting a value doctor cannot honor.
- Literal secrets, URLs containing credentials, or unknown forms → schema error naming `git.push_auth`.

**Rationale:** Matches the issue’s `https-token:<env>` shape, stays one field for operators, and keeps secrets out of YAML. Structured internal representation keeps transport selection pure and unit-testable.

**Alternatives considered:**

- Nested object `{ mechanism, token_env }` only → clearer schema but more verbose YAML; can be added later as a dual form if needed.
- Accept `app` now as a no-op → operators configure dead config; reject is safer.
- Global env-only override without file config → insufficient for checked-in repo policy; env override MAY still win for ephemeral runners if we add `PIPELINE_GIT_PUSH_AUTH` with the same string grammar (optional; prefer file-first + document env if already common for similar keys).

### 2. Central push-auth resolver + apply seam for managed worktree pushes

**Choice:** Introduce a small pure/module seam (names illustrative):

1. `resolveGitPushAuth(config)` → structured mechanism (already part of `resolveConfig` output).
2. `selectPushTransport(auth)` → `{ transport: "ssh" | "https-token", tokenEnv?: string }` for tests.
3. `applyPushAuthForWorktree(worktreePath, auth, deps)` / `runConfiguredPush(...)` — the **only** place that prepares credentials for a pipeline worktree push:
   - **ssh:** push via existing `origin` without injecting a GitHub PAT. Prefer the configured remote URL/pushurl as-is when it is SSH. Do not promote ambient `gh` HTTPS credentials as the pipeline’s chosen transport.
   - **https-token:** for the duration of the push only, authenticate HTTPS using `process.env[tokenEnv]` (via a short-lived credential helper, `GIT_ASKPASS`, or equivalent that never logs the value). Do not persist the token into `.git/config` as a lasting remote URL with embedded secret.

Wire engine stage push call sites that operate on managed worktrees (implementing `pushWithCurrencyCheck`, fix-round push, eval/visual fix push, and any shared helper they already use) through this seam so transport selection is single-sourced.

**Rationale:** The bug is dual-path auth. A single apply seam makes default SSH consistent and makes HTTPS opt-in explicit.

**Alternatives considered:**

- Prompt-only guidance to the model (“use SSH”) → insufficient; models and `gh` credential helpers still rewrite transport.
- Rewrite `origin` permanently at worktree create → heavier; risks breaking fetch and operator expectations; prefer push-time apply.

### 3. Harness consistency without owning every model keystroke

**Choice:** Combine:

1. Engine always performs the authoritative post-stage push through the configured seam (already true for implementing).
2. When preparing harness env for stages that may push, set env / git config for the worktree so that if the model runs `git push`, it inherits the same mechanism (SSH remote preference; or HTTPS-token helper when configured). Document in implement/fix prompts that push auth is pipeline-configured and not to switch remotes to HTTPS via `gh auth setup-git` ad hoc.
3. Classify GitHub “refusing to allow a Personal Access Token … without `workflow` scope” as a **real push failure** with an augmented operator message when mechanism is HTTPS-token (name the missing scope and the env var **name**). When mechanism is SSH and that HTTPS-only rejection text appears, treat it as evidence of wrong transport (harness/helper divergence) and surface a message that points operators at `git.push_auth: ssh` and disabling HTTPS credential fallback — still a visible failure, not a silent “success then block” without explanation.

**Rationale:** Perfect model sandboxing is out of scope; making the default path SSH-native and making HTTPS opt-in removes the common false block. Failures stay visible and actionable.

**Alternatives considered:**

- Strip `GH_TOKEN` from harness env always → may break legitimate `gh` API use during implement; do not blanket-strip.
- Force-disable `gh auth git-credential` globally on the host → too invasive; scope to worktree/push invocation where practical.

### 4. Doctor admission

**Choice:** Add a doctor check that:

- Reports the resolved mechanism (`ssh` or `https-token` + env var **name**).
- **ssh:** pass when config resolves to ssh (optional warn if `origin` URL is clearly HTTPS when observable without network — implementation may keep this soft).
- **https-token:** **fail** when the named env var is unset or empty; never print the value. Pass when set (doctor does not call GitHub to validate scopes in this change unless an existing lightweight probe is free; scope validation remains push-time fail-fast).

**Rationale:** Matches existing doctor style (local readiness, injectable deps). Full GitHub scope introspection is optional future work; push-time error text already names `workflow` scope.

### 5. Fail-fast messaging for missing `workflow` scope

**Choice:** On push failure, if stderr matches GitHub’s workflow-scope refusal (or equivalent), rewrite/augment the blocked reason to:

- name the configured mechanism,
- name the env var (for https-token) or recommend SSH for workflow files,
- state that the PAT/token needs `workflow` scope (or switch to `git.push_auth: ssh`).

Do not invent a new blocker kind unless existing `push-failed` recipes cannot carry the detail — prefer `push-failed` with a clear reason string so recovery recipes stay valid.

**Rationale:** Acceptance criteria require clear fail-fast, not a new state machine edge.

### 6. Docs

**Choice:** Short section in operator docs / README (and config scaffold comments / generated config reference when present) covering:

| Mechanism | When to use | Workflow-file notes |
|-----------|-------------|---------------------|
| `ssh` (default) | Deploy key or SSH agent already used for the repo | Preferred; no `workflow` scope |
| `https-token:ENV` | Hosts that must push over HTTPS with a scoped token | Token MUST include `workflow` if changes touch `.github/workflows/**` |
| `app` (future) | Short-lived App installation tokens | Not implemented in this change |

## Risks / Trade-offs

- **[Risk] Model still runs raw HTTPS push despite guidance** → Mitigation: engine authoritative push uses configured seam; worktree env prefers configured transport; clear error if workflow-scope HTTPS rejection appears.
- **[Risk] Token leaked via remote URL in `.git/config`** → Mitigation: short-lived credential helper / env only; never write token into committed or durable remote URL; redact in logs (existing artifact sanitization).
- **[Risk] Incomplete call-site coverage leaves one stage on ambient auth** → Mitigation: inventory managed-worktree push sites in tasks; central helper; tests on resolver + at least one stage wiring path.
- **[Risk] Operators set `https-token` without `workflow` and blame the pipeline** → Mitigation: doctor checks env presence; fail-fast message names scope; docs table.
- **[Risk] Rejecting `app` now surprises operators who read the issue’s future bullet** → Mitigation: document reserved status; clear schema error text.

## Migration Plan

1. Ship with default `ssh` — no config change required for existing SSH-based hosts; behavior becomes more consistent (fewer false HTTPS blocks).
2. Operators who must use HTTPS add `git.push_auth: https-token:THEIR_ENV` and set the env var to a token with appropriate scopes.
3. Rollback: revert the change; remove the `git:` block if present. No data migration.

## Open Questions

None that block implementation. Optional follow-ups (not this change):

- Full `app` mechanism with installation-token minting.
- Doctor probe that validates GitHub token scopes via API before a run.
- Env override `PIPELINE_GIT_PUSH_AUTH` if operators need file-free ephemeral config (add if implementer finds an established env-override pattern for similar single-field settings; otherwise file-only is enough for v1).
