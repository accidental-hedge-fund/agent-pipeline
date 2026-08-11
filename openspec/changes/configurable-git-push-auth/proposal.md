## Why

When a change touches `.github/workflows/**`, ship/advance often sets a false `pipeline:blocked` at implementing because a model harness (or ambient `gh auth git-credential`) retries the push over HTTPS with a classic PAT that lacks the `workflow` scope. Worktrees are already provisioned with an SSH `origin` that can push workflow files without that scope, and the branch/PR often already lands — yet the failed HTTPS path is misclassified as `push-failed`. Operators need a single, configurable git-push auth mechanism that every harness and engine push uses consistently.

## What Changes

- Add `git.push_auth` under a strict optional `git` block in `.github/pipeline.yml`:
  - **`ssh`** (default) — use the worktree’s existing SSH `origin` / **`pushurl` first** (deploy key or SSH agent). No GitHub `workflow` scope required.
  - **`https-token:<env>`** — push over HTTPS using the token from a named env var (never a literal secret). Operators who expect workflow-file updates supply a PAT/App token **with `workflow` scope**.
  - **`app`** — **rejected at schema/resolve time** in this change (reserved future; not a no-op accept).
- Resolve the mechanism from env-var **names** only, matching the existing executor `credential` env-var pattern in `config.ts`.
- Route **every** authoritative pipeline-owned push through one centralized helper (`runConfiguredGitPush`), including implement/fix/eval/visual, pre-merge archive/autofix/rebase, loop repair, intake/sweep/backfill/roadmap/merge-queue delivery — no stage keeps an ambient-credential bypass.
- HTTPS-token auth is injected without token-bearing durable remote URLs, argv secrets, or logged secret values; ambient `gh auth git-credential` must not win over the configured token for that push.
- Prepare worktree/harness env so harness-initiated `git push` inherits the same transport; a non-authoritative harness HTTPS workflow-scope rejection must not set `push-failed` after successful engine delivery.
- Fail fast when HTTPS env is missing (before Git) or when GitHub refuses missing `workflow` scope (clear message naming mechanism + env-var name).
- Admit the config in schema validation and `pipeline doctor` (HTTPS missing env = doctor fail).
- Docs + unit tests: config round-trip, pure transport selection, **and** execution-seam assertions (git env/argv/helper setup, mapped workflow-scope errors).

## Capabilities

### New Capabilities

- `configurable-git-push-auth`: operator-selected git-push authentication mechanism (`ssh` default, opt-in `https-token:<env>`), consistent application across engine and harness worktree pushes, fail-fast messaging for missing workflow scope on HTTPS, and docs/doctor admission of the config.

### Modified Capabilities

- `pipeline-configuration`: accept and validate the new `git` / `git.push_auth` (or equivalent) config surface with env-var-name credential references only; default remains SSH.
- `doctor-preflight`: surface the configured push-auth mechanism and fail or warn when the selected mechanism cannot be resolved (e.g. named env var for `https-token` is unset).

## Acceptance criteria

- [ ] `resolveConfig()` admits `git.push_auth: ssh` and `https-token:<ENV>` (ENV env-name grammar only); absent `git` defaults to structured `{ mechanism: "ssh" }`.
- [ ] `resolveConfig()` rejects `app`, empty/malformed `https-token:` forms, raw-token-looking values, and unknown keys under `git`, with errors that identify `git.push_auth` (or the unknown key).
- [ ] Resolved config never stores a secret token value — only mechanism + optional env-var **name**.
- [ ] `pipeline doctor` reports the resolved mechanism; SSH check passes; HTTPS-token with unset/empty env **fails** naming the env var and never printing its value; HTTPS-token with set env passes presence readiness.
- [ ] Every authoritative pipeline-owned delivery push listed in `design.md` routes through the centralized push helper (no bypass ambient path for those sites).
- [ ] With default `ssh`, authoritative push uses SSH `origin`/`pushurl` without requiring a PAT `workflow` scope; implementing (or equivalent) does **not** set `pipeline:blocked` / `push-failed` solely because a non-authoritative HTTPS/`gh` path lacked that scope after engine delivery succeeded.
- [ ] When `https-token:<env>` is configured, authoritative pushes authenticate with that env var only — not ambient `gh auth git-credential` — and do not leave a durable token-bearing remote URL.
- [ ] Missing/empty HTTPS env fails before Git with a message that names the env var.
- [ ] HTTPS-token + missing `workflow` scope on a workflow-file push fails fast as a real `push-failed` (or equivalent push failure) naming mechanism, env-var name, and `workflow` scope — never the token.
- [ ] Unit tests cover config round-trip, pure transport selection, invalid rejections, execution-seam git env/invocation, workflow-scope mapping, doctor cases, and harness false-block regression.
- [ ] Docs describe `ssh`, `https-token:<env>`, when to use which, `workflow` scope for workflow files, env-name-only secrets, and that `app` is not implemented.
- [ ] `npm run ci` passes from the repo root (including `plugin/` mirror check when `core/` is edited).

## Impact

- `core/scripts/config.ts` / `types.ts` — schema, defaults, structured push-auth on `PipelineConfig`.
- New central helper module (e.g. `core/scripts/git-push-auth.ts`) + wiring at every delivery push site in `design.md`.
- Harness env preparation (`InvokeOptions.env` / worktree prep) for implement/fix and related stages; classification guard against false `push-failed`.
- `pipeline doctor` preflight check.
- Config scaffold comments, README / config reference.
- Unit tests under `core/test/`.
- `plugin/` mirror regeneration when `core/` is edited.
- No change to merge authority, review policy, or the never-auto-merge floor.
- Full GitHub App installation-token path remains future work; `app` is schema-rejected now.
