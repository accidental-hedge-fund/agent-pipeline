## Approach

`runStatus` already reads `detail.comments` (from `getIssueDetail`). When `stage === "needs-human"`, it calls `needsHumanPunchlist(detail.comments)` and prints the result (or the fallback if null).

## Parsing strategy

The ceiling comment body has this fixed structure emitted by `reviewCeilingComment` in `review.ts`:

```
## Pipeline: Review ceiling reached — human decision required

**Reviewer**: <name>
Review <N> re-ran <cap> times and still has <count> blocking finding(s)...

### Unresolved blocking findings
- `<key>` **[SEVERITY]** <title>
- ...

### To resume
- Accept a finding: comment `--override "<key>: <reason>"` (audited)...
- Or fix the finding(s) by hand and relabel...
```

The helper counts blocking findings by counting bullet lines (lines starting with `- `) in the section between `### Unresolved blocking findings` and the next `###` header or end-of-comment. This is a mechanical string operation over a controlled format — no free-text heuristics.

## Pure helper signature

```ts
function needsHumanPunchlist(comments: IssueComment[]): string | null
```

- Scans `comments` in reverse to find the last comment whose `.body` starts with `## Pipeline: Review ceiling reached`.
- Extracts the `### Unresolved blocking findings` section, counts `- ` prefixed lines → `count`.
- Returns a multi-line string: count line + resume hint.
- Returns `null` if no ceiling comment exists.

The helper lives in `pipeline.ts` (alongside `runStatus`) since it is only used there and ~15 lines. No new module needed.

## Resume hint text

```
Unresolved blocking findings: <count>
To resume: --override "<key>: <reason>" (audited), then relabel pipeline:needs-human → pipeline:review-2
         — or fix the finding(s) by hand and relabel to pipeline:review-2.
```

## Test seam

Unit tests call `needsHumanPunchlist` directly with synthesized comment arrays — no `gh`, no network. The `runStatus` integration path is tested by existing or new integration-level tests if desired; the pure helper is the primary unit-test target.
