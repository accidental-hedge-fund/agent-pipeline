## 1. Read existing code

- [ ] 1.1 Read `gatherCarryForward` in `core/scripts/stages/planning.ts` (lines ~604–628) to confirm the current signature, the `deps.run(title, ...)` call, and the `CarryForwardDeps` interface
- [ ] 1.2 Confirm both call sites (freeform flow line ~72; OpenSpec flow line ~317) have `body` already in scope from `getIssueDetail`
- [ ] 1.3 Read `core/test/planning.test.ts` to understand existing test patterns for `gatherCarryForward` and `buildSetupHint`

## 2. Implement `buildResearchTopic`

- [ ] 2.1 Add `export function buildResearchTopic(title: string, body?: string): string` to `core/scripts/stages/planning.ts`
  - Returns `title` when `body` is absent, empty, or whitespace-only
  - Appends `body` verbatim when `body.length <= 400` (after trim)
  - Appends `body` truncated to 400 chars at the nearest word boundary with a `…` suffix when `body.length > 400`
- [ ] 2.2 Update `gatherCarryForward` signature: add `body?: string` as the fourth parameter (before `deps`)
- [ ] 2.3 Replace `deps.run(title, ...)` with `deps.run(buildResearchTopic(title, body), ...)`

## 3. Update call sites

- [ ] 3.1 In `advance()` (freeform flow, line ~72): pass `body` as the fourth argument to `gatherCarryForward`
- [ ] 3.2 In `advanceOpenspec()` (OpenSpec flow, line ~317): pass `body` as the fourth argument to `gatherCarryForward`

## 4. Unit tests

- [ ] 4.1 `buildResearchTopic`: `body` absent → returns `title` unchanged
- [ ] 4.2 `buildResearchTopic`: `body` empty string → returns `title` unchanged
- [ ] 4.3 `buildResearchTopic`: `body` whitespace-only → returns `title` unchanged
- [ ] 4.4 `buildResearchTopic`: short body (≤ 400 chars) → returns `"${title}\n\n${body}"`
- [ ] 4.5 `buildResearchTopic`: long body (> 400 chars) → returns bounded string ending with `…`, length ≤ title.length + 2 + 400 + 1
- [ ] 4.6 `gatherCarryForward`: `body` present → `run()` receives `buildResearchTopic(title, body)` not just `title`
- [ ] 4.7 `gatherCarryForward`: `body` absent → `run()` receives just `title` (no regression)
- [ ] 4.8 Run `cd core && npm test` — all tests pass
