## 1. Shared classifier

- [x] 1.1 Add an exported complete #1038 park stderr fixture (`! [rejected]`, `non-fast-forward`, behind-remote / `fetch first`) next to `pushWithCurrencyCheck`.
- [x] 1.2 Export one case-insensitive `classifyPushFailure` and call it **before** retry eligibility on every wrapper path, including the fail-closed `siteId` path. Non-fast-forward class → `reason_code: "workflow-state"`, `head_drift: true`.
- [x] 1.3 Keep HTTP 5xx / connection-reset (no nff tokens) as `transient-infra` with existing currency-check retry. Do not force-push on any path.

## 2. Callers and skip-push

- [x] 2.1 Audit every `pushWithCurrencyCheck` caller (`stages/fix.ts`, `stages/planning.ts`). Each `push-failed` diagnostic SHALL emit `pushResult.reason_code`. Remove the fix.ts `head_drift ? workflow-state : transient-infra` remap. Planning SHALL not omit the diagnostic.
- [x] 2.2 After a `fix-no-actionable-work` decision, verify the target head (open-PR head, else fetch + `FETCH_HEAD` / `origin/<branch>`), then `merge-base --is-ancestor HEAD <verified-head>`. Equality and remote-ahead skip the push and advance. Verification failure does not skip and does not reset (fall through to the wrapper). Local-ahead / diverged uses the wrapper and keeps unique commits.
- [x] 2.3 Do not add a second classifier. Both callers use `classifyPushFailure` via the shared wrapper.

## 3. Recovery recipe

- [x] 3.1 When `resync_workflow_state` is claimed for `workflow-state` + `push-failed` / stale-tip evidence: resolve open-PR head first, else fetch and verify `origin/<branch>`. Fast-forward or `reset --hard` only a clean, non-unique managed tree (`merge-base --is-ancestor HEAD <verified-head>`). Absent tree rematerializes onto that tip via `ensureManagedWorktree`. Unverified target refuses typed (`unverified-remote-head`) with no reset.
- [x] 3.2 After the currency action succeeds, keep the existing blocked-label clear + re-enter postcondition. Do not use `wait_and_retry` for this class.
- [x] 3.3 Dirty product or local-only unique commits: return `{ succeeded: false }` with typed evidence (`dirty-worktree` / `local-only-unpushed`). Do not clear blocked. Do not force-push. Class stays `workflow-state`. Next recipe remains `repair_pipeline_item`, never `wait_and_retry`.

## 4. Tests

- [x] 4.1 End-to-end (injected deps): #1038 fixture → wrapper `workflow-state` / `head_drift` → fix `push-failed` diagnostic → durable class `workflow-state` → first recipe `resync_workflow_state`, and the recipe list does not contain `wait_and_retry`. Also document that the pre-fix mapping is `transient-infra` + `wait_and_retry`. Include fail-closed `siteId`.
- [x] 4.2 Assert durable projection is `workflow-state`, not `transient-rate-limit`.
- [x] 4.3 Keep / extend HTTP 502 and connection-reset retry coverage on the same site after currency re-sync.
- [x] 4.4 Noop ancestry: remote-ahead and equal skip push and advance (`fix-1`→`review-2` / `fix-2`→`pre-merge`) without `push-failed`. Local-ahead / diverged invokes the wrapper and preserves unique commits. Verification failure does not skip and does not reset.
- [x] 4.5 Assert rematerialize/fast-forward is invoked for the stale-tip recipe. Capture constructed git/push argv and assert no `--force` / `--force-with-lease`. Dirty / local-only refuse stays typed and is not `wait_and_retry`.
- [x] 4.6 Inject deps. No real network, git, or subprocess.

## 5. Mirror and gate

- [x] 5.1 After `core/` edits, run `node scripts/build.mjs` and commit regenerated `plugin/`.
- [x] 5.2 Run `npm run ci`. Do not claim green until that command exits 0.
