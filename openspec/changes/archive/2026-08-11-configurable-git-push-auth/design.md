## Context

See `proposal.md` for motivation (false `push-failed` blocks when workflow files meet an HTTPS PAT without `workflow` scope).

Current engine state that shapes the design:

- Managed worktrees inherit the parent repo’s `origin` (and any `remote.origin.pushurl`). Operators typically use SSH (`git@github.com:owner/repo.git`). SSH has no GitHub “workflow scope” concept, so workflow-file pushes succeed when the remote and credentials stay on SSH.
- Deterministic stage pushes invoke `git push` / `git push -u origin <branch>` via helpers such as `pushWithCurrencyCheck` and stage-local `gitPush` / `gitFn` deps. They do **not** currently select an explicit auth mechanism beyond ambient git config and credential helpers.
- Model harnesses run in the worktree with full git/gh CLI access. Fix prompts instruct commit+push; implement prompts say do-not-push but models may still push. Ambient `gh auth git-credential` may authenticate HTTPS against a classic PAT (`repo`, `read:org`, …) **without** `workflow`. GitHub then rejects updates under `.github/workflows/**`.
- Existing config credential fields (executors, product-fault intake, etc.) store **env-var names / secret references only**, never literal secrets. New push auth MUST match that pattern (see `credential` on executor schemas in `core/scripts/config.ts`).
- `pipeline doctor` is the operator-facing preflight surface for auth and environment readiness (`core/scripts/stages/doctor.ts` + `DoctorDeps` injectable seam).

## Goals / Non-Goals

**Goals:**

- Single operator-selected push auth mechanism with default `ssh`.
- **One** centralized push-transport apply seam for every authoritative managed-worktree (and equivalent pipeline-owned delivery) push; no stage retains a bypass path that uses ambient credentials as the selected transport.
- Enforceable harness alignment (worktree env / remote preparation), not prompt-only guidance.
- Authoritative engine delivery success is not overturned into `push-failed` solely by a non-authoritative harness HTTPS/`gh` push rejection.
- Clear fail-fast diagnostics when HTTPS-token auth is missing `workflow` scope on workflow-file paths (and when the named env is missing/empty before Git runs).
- Schema + doctor admission; unit tests at pure selection **and** execution seams (no real network).

**Non-Goals:**

- Implementing a full GitHub App installation-token minting flow (`app`). The value `app` is **rejected at schema/resolve time** in this change.
- Changing merge authority, review policy, force-push policy, or currency-check retry policy.
- Storing or logging secret values; embedding tokens in durable remote URLs, argv, prompt text, or error output.
- Guaranteeing a misbehaving model can never invoke raw `git`/`gh` outside prepared env; the design makes the configured mechanism the authoritative path and prepares the worktree so ordinary `git push` inherits it.
- Rewriting unrelated host checkout operations that are not pipeline delivery of managed work (unless they already share the same push helper after centralization).

## Decisions

### 1. Config surface: nested `git.push_auth` — reject `app` and all invalid forms

**Choice:** Add an optional strict `git` block to `PartialConfigSchema`:

```yaml
git:
  push_auth: ssh                    # default when absent
  # push_auth: https-token:GITHUB_PUSH_TOKEN   # env-var NAME only
```

Resolved `PipelineConfig` always exposes a structured form:

- `{ mechanism: "ssh" }`
- `{ mechanism: "https-token", tokenEnv: "GITHUB_PUSH_TOKEN" }`

**Validation (strict, field identity `git.push_auth` or unknown key under `git`):**

| Input | Result |
|-------|--------|
| absent `git` / absent `push_auth` | `ssh` |
| exact `ssh` | `ssh` |
| `https-token:<ENV>` where ENV matches `^[A-Za-z_][A-Za-z0-9_]*$` | `https-token` + env name only |
| empty / whitespace ENV after `https-token:` | reject |
| `app` | **reject** — reserved, not implemented |
| unknown keys under `git:` | reject (`.strict()`) |
| malformed prefixes/suffixes (`https-token`, `https-token:`, `https_token:X`, `ssh:extra`) | reject |
| raw-token-looking values (e.g. `ghp_…`, `github_pat_…`, URLs with embedded credentials, values that are not the two admitted forms) | reject — never persist into resolved config |
| unknown mechanism strings | reject |

**Rationale:** Spec requires structured resolution, env-name-only secrets, and explicit `app` rejection. Matches executor `credential` env-var-name pattern in `config.ts`.

**Alternatives considered:** Accept `app` as no-op → dead config; rejected. Nested object YAML only → clearer but more verbose; string form matches issue + can dual-form later.

### 2. One centralized push-transport helper — exhaustive call-site list

**Choice:** Introduce a single module seam (names illustrative; prefer co-location under `core/scripts/`, e.g. `git-push-auth.ts`):

1. **`parseGitPushAuth` / resolve in `resolveConfig`** → structured `GitPushAuth` on `PipelineConfig` (default SSH).
2. **`selectPushTransport(auth)`** → pure `{ transport: "ssh" | "https-token"; tokenEnv?: string }` for unit tests.
3. **`runConfiguredGitPush(opts)`** — the **only** place pipeline code prepares credentials and invokes push for delivery:
   - Inputs: `cwd`, branch/refspec args, `auth`, injectable `env` + `gitExec` deps, optional flags (`-u`, force-with-lease strings as already used by callers).
   - **ssh:** resolve push endpoint from `remote.origin.pushurl` if set, else `remote.origin.url`; push with that endpoint without injecting a PAT. Do **not** rewrite durable fetch URL solely to “fix” HTTPS. Honor existing SSH `pushurl`.
   - **https-token:** fail **before** invoking Git if `process.env[tokenEnv]` is unset/empty (message names env var only). For the push invocation only: authenticate HTTPS with that token via short-lived env (`GIT_ASKPASS` / credential helper process / env-bound helper) such that:
     - the token never appears in argv, durable `.git/config` remote URL, prompt text, or operator-visible error strings;
     - ambient `gh auth git-credential` is **not** the selected credential source (`credential.helper` chain for the push invocation must not win over the configured token — e.g. empty/disable helper for the child + explicit askpass, or equivalent injectable approach proven in tests).
   - On failure, pass stderr through **`formatPushAuthFailure(auth, stderr)`** (below) before returning to stages.

4. **`prepareWorktreePushAuthEnv(worktreePath, auth, deps)`** — worktree/process preparation so a harness-initiated `git push` inherits the same transport (SSH endpoint preference; or HTTPS-token helper for the harness child env). Durable config must not leave a token-bearing remote URL after the stage.

**Authoritative call sites that MUST route through `runConfiguredGitPush` (no direct ambient `git push` for delivery):**

| Site | File (approx) | Today |
|------|----------------|-------|
| Implementing / plan-resume push | `stages/planning.ts` via `pushWithCurrencyCheck` | `git push -u origin <branch>` |
| Fix-1 / fix-2 push | `stages/fix.ts` via `pushWithCurrencyCheck` | `git push origin <branch>` |
| Eval-gate fix push | `stages/eval.ts` `defaultGitPush` | `git push origin <branch>` |
| Visual-gate fix push | `stages/visual.ts` `defaultGitPush` | `git push origin <branch>` |
| OpenSpec archive push | `stages/pre-merge-openspec-archive.ts` | `git push origin <branch>` |
| Pre-merge autofix push | `stages/pre-merge-autofix.ts` | `git push origin <branch>` |
| Pre-merge conflict rebase push | `stages/pre-merge-conflict-rebase.ts` | `git push --force-with-lease origin <branch>` |
| Loop repair push | `loop/repair-pipeline-item.ts` | `git push origin HEAD:refs/heads/<branch>` |
| Intake reserve + publish | `stages/intake.ts` | `git push` create-only + publish |
| Sweep reserve + publish | `stages/sweep.ts` | same pattern |
| Backfill publish | `stages/backfill.ts` | `git push -u origin <branch>` |
| Roadmap deps publish | `stages/roadmap-deps.ts` | `git push` refspec |
| Merge-queue repair push | `stages/merge-queue.ts` | force-with-lease bound push |

**Wiring strategy:** Prefer making `pushWithCurrencyCheck`’s injectable `git` callback use `runConfiguredGitPush` for the push argv case, and rewrite each remaining direct `["push", …]` / `spawnSync("git", ["push", …])` delivery site to the same helper. Grep after implementation: no production stage path should call raw push for managed delivery outside the helper (tests may still fake the seam).

**Out of scope for rewiring unless they already share the helper:** release tag push on main checkout operator flows that are not managed-worktree delivery; human operator instructions in comments. Prefer centralizing managed-worktree delivery first; intake/sweep/backfill/roadmap/merge-queue are still pipeline-owned pushes and **are in scope** so HTTPS-token hosts do not diverge on those paths.

**Rationale:** Reviewer correctly rejected “e.g.” incomplete inventories. Dual-path auth is the bug; one seam is the fix.

### 3. HTTPS injection without token leakage; defeat ambient `gh` credential helper

**Choice (implementation constraints, tested at the execution seam):**

- **Never** set `origin` URL to `https://<token>@host/...` in durable git config.
- **Never** pass the token on argv (`git -c …` values must not embed the secret in logged command records; prefer env-only helper).
- Child env for push may carry the token only in a private env key consumed by askpass/helper; command records and blocker messages redact via existing artifact sanitization + explicit message builders that only receive the **env-var name**.
- For HTTPS-token pushes, set invocation env so credential lookup does not fall through to `gh auth git-credential` (disable ambient helpers for that child, or put the pipeline helper first with a force-stop). Unit tests assert the constructed env/argv/helper setup, not a live GitHub call.
- For SSH, do not inject PAT; do not force HTTPS. If `origin` is HTTPS but mechanism is `ssh`, document that operators should use SSH remotes/pushurl; optional soft doctor note is OK. Do not silently convert fetch transport in a way that breaks clones.

### 4. Harness consistency is enforceable; non-authoritative failures cannot false-block

**Choice:**

1. **Authoritative delivery** remains the engine post-stage `runConfiguredGitPush` path (implement/fix/eval/visual/archive/autofix/etc.).
2. **Before** implement/fix (and other push-capable harness stages), call `prepareWorktreePushAuthEnv` so worktree remote/pushurl and harness `InvokeOptions.env` align with configured mechanism (same env helper as engine for HTTPS-token).
3. Prompt updates are **secondary**: keep “pipeline owns push” where already stated; for fix (which mentions push), state that push auth is pipeline-configured and remotes must not be switched to ambient HTTPS via `gh auth setup-git`.
4. **False-block guard:** When classifying stage outcome after harness exit, a harness stderr/stdout match for GitHub workflow-scope HTTPS refusal (or generic remote rejected for workflow files via PAT) **must not** alone set `push-failed` / `pipeline:blocked` if the subsequent authoritative engine push succeeded (or if the stage contract is “engine pushes after harness,” as implementing already is). Implement this as an explicit classification rule near implement/fix outcome handling (and any path that currently promotes harness push text into `push-failed`). Regression test: simulate successful engine SSH push + harness workflow-scope noise → stage advances (or at least does not block solely for that noise).

**Rationale:** Prompt-only is insufficient (reviewer). Env preparation + authoritative-engine ownership closes the dual-path bug without full model sandboxing.

### 5. Workflow-scope error translation (precise)

**Choice:** Pure function `formatPushAuthFailure(auth, stderr, opts?)`:

- Detect GitHub workflow-scope refusal (substring match on known refusal text, e.g. `workflow` scope / “refusing to allow a Personal Access Token” + workflow path).
- Operator-visible message **must**:
  - remain a **push failure** (blocker kind stays `push-failed` where that kind already applies);
  - name configured mechanism (`ssh` or `https-token`);
  - for `https-token`, name env-var **name** only (never value);
  - name missing `workflow` scope (or include sanitized GitHub refusal that already names it);
  - never include token material.
- Missing/empty env for `https-token`: fail **before** Git with message naming the env var — distinct from workflow-scope (credential not configured vs. insufficient scope).
- When mechanism is `ssh` and the **authoritative** push somehow still surfaces that HTTPS-only refusal, treat as wrong-transport evidence in the message (point operators at remotes/`pushurl` and `git.push_auth: ssh`), still as a real push failure for the authoritative path.

### 6. Doctor admission

**Choice:** New check id e.g. `git-push-auth` in `buildPreflightChecks`:

- Report mechanism `ssh` or `https-token` + env **name**.
- `ssh`: **pass** config admission (no PAT workflow scope required).
- `https-token` + env unset/empty: **fail**, message names env var, never value.
- `https-token` + env set: **pass** presence readiness (no live scope probe in this change).
- Unit-testable via `DoctorDeps` without network push.

### 7. Docs

Short operator section (README and/or scaffold comments + config reference touchpoints):

| Mechanism | When to use | Workflow files |
|-----------|-------------|----------------|
| `ssh` (default) | Deploy key / SSH agent | Preferred; no `workflow` scope |
| `https-token:ENV` | Must push over HTTPS | Token **must** include `workflow` for `.github/workflows/**` |
| `app` | Future App tokens | **Not implemented** — schema rejects |

State: config holds env-var names only, never secrets.

## Risks / Trade-offs

- **[Risk] Incomplete call-site coverage** → Mitigation: exhaustive table above; post-impl grep; tests on helper + at least implement/fix wiring.
- **[Risk] Token leak via remote URL / logs** → Mitigation: no durable token URL; askpass/env only; redaction + message builders receive names only; tests assert absence of secret in recorded command/error strings.
- **[Risk] Ambient `gh` helper still wins** → Mitigation: child env disables/overrides helpers for configured push; execution-seam tests.
- **[Risk] SSH ignores pushurl** → Mitigation: read `remote.origin.pushurl` first when selecting SSH push endpoint.
- **[Risk] HTTPS endpoint derivation breaks non-github hosts** → Mitigation: derive host/path from existing origin URL; do not hardcode only `github.com` if origin already names another host.
- **[Risk] Harness still false-blocks** → Mitigation: classification guard + regression test separate from engine delivery.
- **[Risk] Rejecting `app` surprises readers of issue bullet** → Mitigation: schema error text + docs “not implemented”.

## Migration Plan

1. Default `ssh` — no config change for existing SSH hosts; fewer false HTTPS blocks.
2. HTTPS hosts set `git.push_auth: https-token:THEIR_ENV` and export a token with needed scopes (including `workflow` when editing workflows).
3. Rollback: revert change; remove `git:` block if present.

## Open Questions

None blocking. Deferred follow-ups: full `app` minting; doctor API scope probe; optional `PIPELINE_GIT_PUSH_AUTH` env override only if an established single-field env-override pattern is found during impl (file-first is enough for v1).
