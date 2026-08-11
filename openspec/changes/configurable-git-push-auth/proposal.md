## Why

When a change touches `.github/workflows/**`, ship/advance often sets a false `pipeline:blocked` at implementing because a model harness (or ambient `gh auth git-credential`) retries the push over HTTPS with a classic PAT that lacks the `workflow` scope. Worktrees are already provisioned with an SSH `origin` that can push workflow files without that scope, and the branch/PR often already lands — yet the failed HTTPS path is misclassified as `push-failed`. Operators need a single, configurable git-push auth mechanism that every harness and engine push uses consistently.

## What Changes

- Add a config key (e.g. `git.push_auth`) to `.github/pipeline.yml` that selects the push authentication mechanism:
  - **`ssh`** (default) — use the worktree’s existing SSH `origin` / `pushurl` (deploy key or SSH agent). No GitHub `workflow` scope required.
  - **`https-token:<env>`** — push over HTTPS using the token from a named env var / secret reference (never a literal secret). Operators who expect workflow-file updates supply a fine-grained PAT or App token **with `workflow` scope**.
  - **`app`** — reserved for a future GitHub App installation-token path; schema may accept or reject it per design (no full implementation required in this change if deferred).
- Resolve the mechanism at invocation time from env-var **names** / secret references only, matching the existing `credential` env-var pattern in config.
- Apply the resolved mechanism to **every** git push the pipeline performs from a managed worktree (engine stage pushes and model-harness guidance / environment), so SSH and HTTPS no longer diverge ad hoc.
- Prefer SSH origin by default; only use HTTPS-token when the operator explicitly configures it. Stop treating ambient `gh auth git-credential` HTTPS fallback as the authoritative push path for pipeline worktrees.
- When HTTPS-token is configured with a token lacking `workflow` scope and the change touches `.github/workflows/**`, fail fast with a clear, operator-actionable message (a real push/auth error), not a silent or misleading false block after a successful branch delivery.
- Admit the config in schema validation and `pipeline doctor`.
- Document each mechanism, when to use which, and the required scope for workflow-file changes.
- Unit tests: config round-trip + transport selection for `ssh` and `https-token`.

## Capabilities

### New Capabilities

- `configurable-git-push-auth`: operator-selected git-push authentication mechanism (`ssh` default, opt-in `https-token:<env>`), consistent application across engine and harness worktree pushes, fail-fast messaging for missing workflow scope on HTTPS, and docs/doctor admission of the config.

### Modified Capabilities

- `pipeline-configuration`: accept and validate the new `git` / `git.push_auth` (or equivalent) config surface with env-var-name credential references only; default remains SSH.
- `doctor-preflight`: surface the configured push-auth mechanism and fail or warn when the selected mechanism cannot be resolved (e.g. named env var for `https-token` is unset).

## Acceptance criteria

- [ ] Config admits `git.push_auth` (or equivalent) with default `ssh`, schema-validated; invalid values fail `resolveConfig()` with a parse error that names the field.
- [ ] `pipeline doctor` admits the key and reports the resolved mechanism; when `https-token:<env>` is selected and the named env var is unset, doctor fails (or warns per design) with a message that names the missing env var (never the secret value).
- [ ] With default `ssh`, a worktree push that modifies `.github/workflows/**` succeeds over SSH origin without requiring a PAT `workflow` scope, and the implementing stage does **not** set a false `pipeline:blocked` / `push-failed` solely because an HTTPS/`gh` credential path lacked that scope.
- [ ] When `https-token:<env>` is configured, engine (and harness-guided) pushes from managed worktrees use HTTPS with the token from that env var only — not ambient `gh auth git-credential` as the selected transport.
- [ ] When `https-token:<env>` is configured with a token lacking `workflow` scope and the change touches `.github/workflows/**`, the failure is fail-fast with a clear message that names the missing `workflow` scope (or equivalent GitHub rejection text) as a real push/auth error — not a silent false block after the branch already delivered.
- [ ] Config never stores a literal secret; only env-var names / secret references are accepted for the HTTPS-token path (same pattern as existing `credential` fields).
- [ ] Unit tests cover: config round-trip for `ssh` and `https-token:<env>`; transport selection returns SSH vs HTTPS-token accordingly; invalid mechanism values are rejected.
- [ ] Docs include a short section describing each mechanism, when to use which, and the required scope for workflow-file changes.
- [ ] `npm run ci` passes from the repo root (including mirror check when `core/` is edited at implementation time).

## Impact

- `core/scripts/config.ts` / `types.ts` — schema, defaults, resolved `PipelineConfig` field(s).
- Engine push call sites that run `git push` from managed worktrees (e.g. implementing via `pushWithCurrencyCheck`, fix, eval/visual fix rounds, and other stage pushes that share the same transport expectations) — resolve and apply the configured mechanism.
- Harness stage prompts / environment so model subprocesses do not silently fall back to HTTPS via `gh auth git-credential` against operator intent.
- `pipeline doctor` preflight checks.
- Config scaffold comments, README / generated config reference (when present).
- Unit tests co-located under `core/test/`.
- `plugin/` mirror regeneration only when implementation edits `core/`.
- No change to merge authority, review policy, or the never-auto-merge floor.
- Full GitHub App installation-token path (`app`) may be schema-reserved and documented as future without shipping a complete App flow in this change.
