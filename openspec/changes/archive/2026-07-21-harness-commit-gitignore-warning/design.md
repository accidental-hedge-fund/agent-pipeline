## Context

Harness commit steps in the implementing (`stages/planning.ts`) and fix-round
(`stages/fix.ts`) stages produce a commit range (`headBefore..HEAD`). Files the
target repo's `.gitignore` excludes are silently omitted by `git add`, so a file the
committed change depends on can vanish without any signal until a downstream CI gate
fails on the missing file. The pipeline already has fail-safe post-commit helpers that
mirror this shape — `salvage-harness-work.ts`, `lockfile-side-effects.ts`,
`build-side-effects.ts` — each with an injectable git deps seam and no real
git/network in unit tests. This change adds a sibling, but strictly **advisory**: it
observes and reports, it never mutates the worktree or blocks.

## Goals / Non-Goals

- Goal: surface a gitignored, change-referenced artifact loudly at the stage that
  produced it, in both stage output and `events.jsonl` run evidence, naming the file
  and the ignore rule/source that excluded it.
- Goal: near-zero false-positive noise on routine ignored clutter.
- Goal: strictly non-fatal — no blocking, no worktree mutation, git errors swallowed.
- Non-Goal: force-adding, un-ignoring, or otherwise committing the excluded file.
- Non-Goal: any change to review/fix blocking semantics or state-machine edges.

## Decisions

### Detection surface
Run after the commit step, only when the harness range is non-empty
(`headBefore && headAfter && headBefore !== headAfter`). An empty range means nothing
was committed, so nothing can reference a dropped artifact.

Enumerate ignored untracked files with
`git ls-files --others --ignored --exclude-standard` (repo-relative paths). This lists
exactly the files present in the worktree that gitignore excludes — the population from
which a dropped artifact must come.

### Change-relevance heuristic (noise control)
Keep an ignored file only when its repo-relative path **or** its basename appears
literally in the text of the committed diff (`git diff <headBefore> <headAfter>`). This
is the concrete instance of the issue's "paths referenced by name in the committed
diff" heuristic and directly matches the observed incident: the committed test named
`benchmark/regime_4cell/results.json`, so the ignored `results.json` is flagged, while
`__pycache__/…`, `node_modules/…`, and stray build output — never named by the diff —
are not. Matching the basename as well as the full path catches a test that references
the artifact by a repo-root-relative or otherwise-normalized path that differs from the
`ls-files` path spelling; the small over-match risk (an unrelated ignored file sharing a
basename mentioned in the diff) is acceptable because the output is advisory, not
blocking.

### Rule/source attribution
For each surviving file, run `git check-ignore -v --no-index -- <path>` and parse the
`<source>:<linenum>:<pattern>\t<path>` line into `{ source, line, pattern }`. If
`check-ignore` yields no match for a path (races, non-standard exclude source), the
file is reported with a null rule rather than dropped, so the warning still names it.

### Reporting
- Stage output: a single `[pipeline] #<issue>: <stage> left gitignored file(s) that the
  committed change references: <path> (ignored by <source>:<line> "<pattern>"), …`
  `console.warn` line.
- Run evidence: one `ignored_artifact_warning` event appended to `events.jsonl` with
  `{ stage, files: [{ path, source, line, pattern }] }`. Additive event type; does not
  change `schema_version` semantics of existing stage-timeline events.

### Fail-safe
The whole detection is wrapped so any thrown git error (or a non-zero
`check-ignore`/`ls-files`) is logged at most once and treated as "no warning". This
mirrors `trySalvageUncommittedWork`: a detection failure must never make a run worse
than it is today.

### Injectability
A `detectIgnoredArtifacts(wtPath, headBefore, headAfter, deps)` function accepts an
`IgnoredArtifactDeps` seam with `gitListIgnored`, `gitDiffText`, and `gitCheckIgnore`
fakes, plus an injectable event emitter, so unit tests exercise every branch with no
real git, network, or subprocess call — matching `SalvageDeps` / `VerifyDeps`.

## Risks / Trade-offs

- Basename matching can over-report in the rare case an unrelated ignored file shares a
  basename mentioned in the diff. Accepted: advisory output, no blocking, and a false
  positive still points a human at a real gitignore interaction worth a glance.
- `git check-ignore` semantics vary slightly across git versions; parsing is defensive
  and a parse miss degrades to "named, rule unknown" rather than dropping the file.

## Migration

None. Purely additive; no config key, no state-machine change, no behavior change for
repos with no change-referenced ignored files.
