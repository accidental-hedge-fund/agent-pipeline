## 1. Shared classifier

- [ ] 1.1 Add an exported #1038 stderr fixture (`non-fast-forward` + behind-remote / `fetch first`) next to `pushWithCurrencyCheck`.
- [ ] 1.2 Make `pushWithCurrencyCheck` return `reason_code: "workflow-state"` and `head_drift: true` when `isTransientPushError` is false for that class, including the fail-closed `siteId` path.
- [ ] 1.3 Keep HTTP 5xx / connection-reset classification as `transient-infra` with existing currency-check retry. Do not force-push on any path.

## 2. Callers and skip-push

- [ ] 2.1 In `stages/fix.ts`, emit the wrapper `reason_code` on `push-failed`. Remove the `head_drift ? workflow-state : transient-infra` remap.
- [ ] 2.2 After a `fix-no-actionable-work` decision, fetch / compare `origin/<branch>`. If local HEAD is an ancestor, skip the push and advance.
- [ ] 2.3 Leave planning on the shared wrapper so it inherits the new classification. Do not add a second classifier.

## 3. Recovery recipe

- [ ] 3.1 When `resync_workflow_state` is claimed for `workflow-state` + `push-failed` / stale-tip evidence, fast-forward the present managed worktree if local HEAD is an ancestor of the open-PR or verified remote tip; otherwise rematerialize onto that tip when rematerialize safety allows.
- [ ] 3.2 After the currency action succeeds, keep the existing blocked-label clear + re-enter postcondition. Do not use `wait_and_retry` for this class.
- [ ] 3.3 Refuse dirty / local-only unpushed product destroy. Never force-push.

## 4. Tests

- [ ] 4.1 Prove the #1038 fixture currently would be `transient-infra` + `wait_and_retry` without the classifier change, and is `workflow-state` + rematerialize/`resync_workflow_state` with it (including fail-closed `siteId`).
- [ ] 4.2 Assert durable projection is `workflow-state`, not `transient-rate-limit`.
- [ ] 4.3 Assert HTTP 502 on the same site still retries after currency re-sync.
- [ ] 4.4 Assert ancestor local HEAD after `fix-no-actionable-work` skips push and advances (`fix-1`→`review-2` / `fix-2`→`pre-merge`) without `push-failed`.
- [ ] 4.5 Assert rematerialize/fast-forward is invoked for the stale-tip recipe and that no test path issues `--force` / `--force-with-lease`.
- [ ] 4.6 Inject deps. No real network, git, or subprocess.

## 5. Mirror and gate

- [ ] 5.1 After `core/` edits, run `node scripts/build.mjs` and commit regenerated `plugin/`.
- [ ] 5.2 Run `npm run ci`. Do not claim green until that command exits 0.
