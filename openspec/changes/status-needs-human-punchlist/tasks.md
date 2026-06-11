## 1. Pure helper

- [ ] 1.1 Implement `needsHumanPunchlist(comments: IssueComment[]): string | null` in `core/scripts/pipeline.ts` — finds last `## Pipeline: Review ceiling reached` comment, counts `- ` lines under `### Unresolved blocking findings`, returns count + resume hint string or null

## 2. runStatus integration

- [ ] 2.1 In `runStatus`, after printing `Stage:`, call `needsHumanPunchlist(detail.comments)` when `stage === "needs-human"` and print the result (or a graceful fallback line if null)

## 3. Unit tests

- [ ] 3.1 Test: `needsHumanPunchlist` with a well-formed ceiling comment returns the correct count and resume hint
- [ ] 3.2 Test: `needsHumanPunchlist` with no ceiling comment returns null
- [ ] 3.3 Test: `needsHumanPunchlist` with multiple ceiling comments uses the last one
- [ ] 3.4 Test: `runStatus` output for a non-`needs-human` stage is unchanged (regression guard)

## 4. CI gate

- [ ] 4.1 Run `npm run ci` from repo root — all tests pass, mirror is in sync
