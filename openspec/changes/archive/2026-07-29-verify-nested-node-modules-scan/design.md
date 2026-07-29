## Context

`worktree-staging-exclusions` is a belt-and-suspenders design:

1. **Prevent** staging `node_modules` (worktree `.git/info/exclude` + salvage pathspecs).
2. **Detect** if a harness still commits it (post-commit scan in `verifyHarnessCommits`).

#521 made salvage exclusion depth-agnostic (`:(exclude,glob)**/node_modules` and
`:(exclude,glob)**/node_modules/**`). The post-commit scan still uses a root-only check:

```ts
if (file.split("/")[0] === "node_modules") { ... }
```

That matches `node_modules` and `node_modules/foo`, but not monorepo paths such as
`apps/web/node_modules/.pnpm/...`. Those commits pass verify and fail later in CI.

## Goals / Non-Goals

**Goals:**

- Align the post-commit scan with salvage: any path containing a `node_modules` **path
  segment** blocks the step.
- Preserve existing diagnostics (SHA + path + "must not be committed").
- Add a biting regression for nested monorepo paths.
- Keep delete-only remediation commits unblocked (still driven by
  `gitDiffTreeFiles` / `--diff-filter=d` excluding deletions).

**Non-Goals:**

- Changing salvage pathspec composition beyond documenting parity with verify.
- Changing worktree bootstrap `.git/info/exclude` (still root `node_modules` pattern;
  nested installs remain gitignored by package managers / project ignore rules and are
  covered by salvage + this scan).
- Broader forbidden-path frameworks, package-manager-specific rules, or other
  dependency-dir names (`vendor/`, `.pnpm-store`, etc.).
- Config knobs or CLI flags for the scan.

## Decisions

### 1. Segment-boundary match, not substring

**Choice:** Treat a path as forbidden iff any path component equals `node_modules`
exactly — equivalent to matching `/(^|\/)node_modules(\/|$)/` on git path strings
(forward-slash separated, as returned by `git diff-tree`).

**Why:** A naive `includes("node_modules")` would false-positive on legitimate names
such as `src/node_modules_backup/index.ts` or `docs/avoiding-node_modules.md`. Segment
equality matches git pathspecs and salvage's intent.

**Alternatives considered:**

| Approach | Rejected because |
| --- | --- |
| Keep root-only `split("/")[0]` | Leaves the monorepo hole open |
| `includes("node_modules")` | False positives on non-segment names |
| Reuse salvage pathspec globs in verify | Verify inspects committed tree paths via
  `gitDiffTreeFiles`, not staging; a pure path predicate is simpler and testable |

### 2. Single shared predicate in the verify module

**Choice:** Implement the check as a small named helper (or inline equivalent) next to
the scan loop in `verify-harness-commits.ts`, used only by the post-commit scan.

**Why:** Minimal surface; the scan already owns the policy. Extracting a cross-module
shared constant with salvage is optional and not required for correctness — salvage
speaks pathspecs; verify speaks path strings.

### 3. Diagnostic shape unchanged

**Choice:** Keep the existing reason string shape:
`Commit <sha> adds a node_modules entry (<path>); node_modules must not be committed`.

**Why:** Operators and tests already key on `node_modules` + SHA + "must not be
committed". Nested paths only change which `<path>` values appear.

### 4. Regression test placement

**Choice:** Extend `core/test/verify-harness-commits.test.ts` with a nested monorepo
case (same injectable `gitDiffTreeFiles` pattern as #180). Prefer a test that would
pass under the legacy root-only predicate and fail under the new one (or document the
bite via dual-predicate assertion similar to #521 salvage tests).

**Why:** Co-located with existing node_modules scan tests; no real git required.

## Risks / Trade-offs

- **[Risk] Over-blocking legitimate paths that intentionally name a directory
  `node_modules` outside dependency installs** → **Mitigation:** By design those must
  never be committed; same policy as root-level scan and salvage. No known product
  need to commit such paths.
- **[Risk] Fix callers reimplement a weaker check** → **Mitigation:** Stage/fix
  external gates that reuse `verifyHarnessCommits` inherit the fix automatically;
  audit only duplicated inline checks if any exist outside the helper.
- **[Trade-off] Bootstrap exclude remains root-only** → Nested installs still rely on
  project/package ignore + salvage + this scan. Expanding bootstrap exclude is out of
  scope and would be a separate change if needed.

## Migration Plan

- Pure behavior tightening on new commits in harness ranges; no data migration.
- After merge, nested `node_modules` in harness ranges block earlier (at verify) instead
  of later (CI). Rollback is revert of the predicate change.

## Open Questions

None — issue scope and the #521 salvage precedent fully constrain the design.
