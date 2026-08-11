## 1. Config schema and resolved types

- [ ] 1.1 Add a strict optional `git` block to `PartialConfigSchema` with `push_auth` string (`ssh` | `https-token:<ENV_NAME>`); reject unknown keys, reserved `app`, empty/invalid env names, and secret-like forms
- [ ] 1.2 Extend `PipelineConfig` / `DEFAULT_CONFIG` with structured push-auth (default `{ mechanism: "ssh" }`) and resolve it in `resolveConfig()`
- [ ] 1.3 Add config scaffold comments (and generated config reference touchpoints if present) documenting `git.push_auth`
- [ ] 1.4 Unit tests: round-trip for `ssh` and `https-token:ENV`; absent default; invalid forms fail with field identity

## 2. Transport selection and push apply seam

- [ ] 2.1 Implement pure transport selection from structured push-auth (`ssh` → SSH; `https-token` → HTTPS bound to env name)
- [ ] 2.2 Implement worktree push apply helper: SSH uses existing origin without injecting a PAT; HTTPS-token uses short-lived credential path from env (no durable token-in-remote-URL)
- [ ] 2.3 On GitHub workflow-scope HTTPS refusal, augment the push failure reason with mechanism, env-var **name**, and missing `workflow` scope guidance
- [ ] 2.4 Unit tests: transport selection; missing HTTPS env fails clearly; workflow-scope stderr produces augmented message (no secret leakage)

## 3. Wire managed-worktree push call sites

- [ ] 3.1 Inventory authoritative managed-worktree push paths (implementing `pushWithCurrencyCheck`, fix-round push, eval/visual fix push, shared helpers)
- [ ] 3.2 Route those paths through the configured push-auth seam so default SSH is consistent and HTTPS-token is opt-in only
- [ ] 3.3 Ensure ambient `gh auth git-credential` is not the selected transport when mechanism is `ssh`
- [ ] 3.4 Regression: with mechanism `ssh`, a successful SSH delivery is not classified as `push-failed` solely due to a non-authoritative HTTPS workflow-scope rejection

## 4. Harness environment and guidance

- [ ] 4.1 Prepare implement/fix (and other push-capable) harness worktree env so git push prefers the configured mechanism
- [ ] 4.2 Update stage prompts (as needed) so harnesses do not reconfigure origin to ambient HTTPS/`gh` credentials against operator intent
- [ ] 4.3 Unit or prompt-loader drift test covering the guidance/env contract where the repo already tests prompts

## 5. Doctor preflight

- [ ] 5.1 Add doctor check: report resolved mechanism; for `https-token`, fail when env unset/empty; never print secret values
- [ ] 5.2 Unit tests with injectable doctor deps for `ssh` pass, `https-token` missing env fail, `https-token` present pass

## 6. Docs, mirror, and CI

- [ ] 6.1 Document mechanisms, when to use which, workflow-scope requirement for HTTPS, and env-var-name-only security rule
- [ ] 6.2 Run `node scripts/build.mjs` if `core/` changed; commit regenerated `plugin/` in the same change
- [ ] 6.3 Run `npm run ci` from the repo root and fix failures until green
- [ ] 6.4 Run `openspec validate configurable-git-push-auth` (and `openspec validate --all` as part of CI) and keep the change structurally valid
