## 1. Config schema and resolved types

- [x] 1.1 Add strict optional `git` block to `PartialConfigSchema` with `push_auth` string; admit only `ssh` and `https-token:<ENV>` (`ENV` = `^[A-Za-z_][A-Za-z0-9_]*$`)
- [x] 1.2 Reject: unknown keys under `git`, reserved `app`, empty/malformed env names, raw-token-looking values, unknown prefixes/suffixes — errors identify `git.push_auth` / offending field
- [x] 1.3 Extend `PipelineConfig` / `DEFAULT_CONFIG` with structured push-auth default `{ mechanism: "ssh" }` and resolve in `resolveConfig()`
- [x] 1.4 Scaffold comments + config-template / generated reference touchpoints for `git.push_auth`
- [x] 1.5 Unit tests: absent → SSH; explicit SSH; valid HTTPS env; `app` reject; empty/malformed env; literal-like values; unknown `git` keys; round-trip equality of structured form

## 2. Central transport selection + push apply seam

- [x] 2.1 Pure `selectPushTransport` (ssh / https-token bound to env name)
- [x] 2.2 `runConfiguredGitPush`: single authoritative push executor
  - SSH: honor `remote.origin.pushurl` if set, else `origin` URL; no PAT injection
  - HTTPS-token: fail before Git if env unset/empty; short-lived env/askpass auth; no durable token-in-remote-URL; ambient `gh auth git-credential` must not win
- [x] 2.3 `formatPushAuthFailure`: workflow-scope refusal → push failure message naming mechanism, env-var **name** (for https-token), missing `workflow` scope; never token value
- [x] 2.4 Unit tests at **execution seam** (injectable git/env): SSH invocation shape; HTTPS env/helper setup; missing env fails pre-Git; workflow-scope stderr mapping; secret never in argv/recorded errors/durable remote URL

## 3. Wire every authoritative push call site

- [x] 3.1 Route through `runConfiguredGitPush` (directly or via `pushWithCurrencyCheck` git callback):
  - `stages/planning.ts` (implement / resume push)
  - `stages/fix.ts`
  - `stages/eval.ts` `defaultGitPush`
  - `stages/visual.ts` `defaultGitPush`
  - `stages/pre-merge-openspec-archive.ts`
  - `stages/pre-merge-autofix.ts`
  - `stages/pre-merge-conflict-rebase.ts`
  - `loop/repair-pipeline-item.ts`
  - `stages/intake.ts` (reserve + publish)
  - `stages/sweep.ts` (reserve + publish)
  - `stages/backfill.ts`
  - `stages/roadmap-deps.ts`
  - `stages/merge-queue.ts` (repair push)
- [x] 3.2 Grep gate: no remaining production managed-delivery `git push` that bypasses the seam
- [x] 3.3 Regression: mechanism `ssh` + successful authoritative push is **not** `push-failed` solely due to non-authoritative HTTPS workflow-scope rejection

## 4. Harness environment (enforceable) + guidance

- [x] 4.1 `prepareWorktreePushAuthEnv` for implement/fix (and other push-capable harness stages); pass aligned `InvokeOptions.env` into harness spawn
- [x] 4.2 Prompt touch-ups only as secondary reinforcement (do not reconfigure origin to ambient HTTPS/`gh` as selected mechanism)
- [x] 4.3 Classification guard: harness-only workflow-scope HTTPS failure does not mark `push-failed` after successful engine delivery
- [x] 4.4 Tests: harness-stage path separate from engine delivery (env prep + false-block regression)

## 5. Doctor preflight

- [x] 5.1 Check reports mechanism; SSH pass; HTTPS-token missing env fail (name only); HTTPS-token present pass
- [x] 5.2 Unit tests via `DoctorDeps` injectable seam — no network push; assert output never contains secret values

## 6. Docs, mirror, and CI

- [x] 6.1 Document `ssh`, `https-token:<env>`, when to use which, `workflow` scope for workflow files, env-name-only rule, `app` not implemented
- [x] 6.2 `node scripts/build.mjs` after `core/` edits; commit regenerated `plugin/` in same change
- [x] 6.3 `npm run ci` from repo root until green
- [x] 6.4 `openspec validate configurable-git-push-auth` (and `--all` via CI)
