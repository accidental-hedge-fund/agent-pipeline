## Context

Root CI runs:

```text
npm run ci → … → npm run ci:scripts → node --test scripts/*.test.mjs
```

(`npm test` also ends with the same multi-file `node --test scripts/*.test.mjs` pattern.)

The scripts suite today is four files (~2.1k LOC total; `install.test.mjs` alone is ~1.5k LOC / ~90 tests). CI uses Node 24 (`ci.yml` / local Node 24.x). Intermittent failures on PR #678 after an archive-only commit showed:

```text
Error: Unable to deserialize cloned data due to invalid or unsupported version.
  at #processRawBuffer (node:internal/test_runner/runner:…)
```

That is a **test-runner host** error while reassembling child-process results, not an assertion in install product code. Pre-merge treats any CI red as a hard block (#181 / `pre-merge-ci-gate`), so the flake is operator-visible and blocks ready-to-deploy even when product tests would pass.

Node 24's runner supports `--test-isolation=process|none` and `--test-concurrency=N`. The deserialize path lives in the parent runner when consuming cloned IPC from child isolation. Hypothesis ranked by evidence fit:

1. **Multi-file / multi-child IPC aggregation race or buffer issue** under the default process-isolation runner when many tests report results (most consistent with intermittent, non-assertion failures).
2. **Large single-file suite under process isolation** stressing the same parent decode path.
3. **Parent/child version skew** (unlikely on a single `setup-node` image with one `node` binary; keep as a disprove-first check).

`install.test.mjs` mutates `process.env` and extends the exported `DEPS` map at module load. Shared-process isolation (`--test-isolation=none` across files) therefore has **cross-file state risk** unless carefully ordered or cleaned up.

## Goals / Non-Goals

**Goals:**

- Remove or greatly reduce the deserialize infrastructure failure from `ci:scripts` / scripts half of `npm test`.
- Prefer a **structural** runner-invocation change over sleep-retry or “rerun CI” culture.
- Keep full scripts test coverage in the `npm run ci` gate.
- When tests fail, operators see product assertion / process failure output, not unparsed runner IPC errors for a green suite.
- Leave a regression guard on the chosen invocation shape where practical.
- Capture root-cause (or best-supported isolation hypothesis) in the PR description.

**Non-Goals:**

- Redesigning pre-merge CI recovery, close+reopen, or infra-flake classification (separate track).
- Demoting review rigor, skipping `ci:scripts`, or marking install tests flaky-skip.
- Rewriting installer product logic for coverage/refactors unrelated to runner reliability.
- Pinning a different major Node version solely to dodge the bug (Node 24 remains the CI runtime unless isolation proves impossible there).
- Guaranteeing zero Node-runtime bugs forever; only stop *this* known flake class for the scripts suite.

## Decisions

### 1. Prefer per-file top-level processes over multi-file runner aggregation

**Choice (preferred):** Change `ci:scripts` (and the scripts half of `npm test` if it shares the same flaky invocation) so each `scripts/*.test.mjs` file is executed as its **own** top-level `node --test <file>` process. Aggregate exit codes (non-zero if any file fails). Optionally fail-fast after first failure for faster local feedback; CI may run all files to surface multiple failures if cheap.

**Why:** The observed error is in the parent multi-file runner's `#processRawBuffer` IPC decode path. One file per top-level Node process keeps Node's test runner useful *inside* each file while avoiding the multi-file parent collecting many child result streams in one process — the path most aligned with the flake signature.

**Alternatives considered:**

| Approach | When to use / reject |
| --- | --- |
| `node --test --test-isolation=none scripts/*.test.mjs` | Reject as first choice: shared process + install tests mutate `process.env` / `DEPS` → cross-file pollution risk |
| `node --test --test-concurrency=1 scripts/*.test.mjs` | May reduce races but still uses multi-file parent IPC; keep as fallback experiment only |
| Keep multi-file runner + sleep/retry wrapper | Reject as primary: paper-over; issue asks for structural preference |
| Split `install.test.mjs` into many files under same multi-file command | May worsen multi-file IPC load; only if product organization demands it |
| Pin older/newer Node | Last resort; wrong layer unless Node documents a fixed runner bug and upgrade is the real fix |

### 2. Implementation shape: small deterministic wrapper vs long npm script

**Choice:** Prefer a tiny Node wrapper (e.g. `scripts/run-scripts-tests.mjs`) invoked by `ci:scripts` / `npm test` scripts half that:

1. Discovers `scripts/*.test.mjs` deterministically (sorted paths).
2. Spawns `process.execPath --test <absolute-or-repo-relative file>` per file with `stdio: inherit`.
3. Returns non-zero if any child exits non-zero (or on spawn failure).

**Why:** Glob expansion and exit-code aggregation in pure npm/`sh -c` loops are brittle across shells; a Node wrapper matches the rest of `scripts/*.mjs` tooling, is unit-testable without network/git, and can assert “one process per file” for the regression guard.

**Acceptable alternative:** If a one-liner with `node --test --test-isolation=…` is proven during implementation to eliminate the flake without cross-file state bugs, the wrapper may be skipped — but then the package.json (or a tiny test) MUST pin the flags that make the fix load-bearing.

### 3. Keep product tests intact; do not “fix” install assertions for flake

**Choice:** Do not weaken, skip, or randomly reorder install product tests to hide the flake. Only runner packaging / isolation changes (plus minimal cleanup if `--test-isolation=none` is ever chosen).

**Why:** Issue acceptance is “stop producing the flake,” not “make CI ignore install failures.”

### 4. Regression guard

**Choice:** Add a unit test (likely under `scripts/`, co-located with the wrapper or reading `package.json`) that:

- Asserts `ci:scripts` does **not** use the bare multi-file form `node --test scripts/*.test.mjs` **if** that form is the abandoned flaky path, **or**
- Asserts the wrapper / flags that implement per-file isolation (or the chosen structural flags) remain wired from `package.json`.

**Why:** Issue asks for a regression that would have failed under the old setup. Invocation-shape tests are the practical bite for runner config; they do not need to reproduce the IPC race in CI.

### 5. Root-cause note discipline

**Choice:** During implementation, attempt a cheap isolation matrix (multi-file default vs per-file vs `isolation=none` vs concurrency=1) enough to support a short PR-description note. Full statistical flake reproduction is not required if the structural fix clearly removes the multi-file IPC path.

**Why:** Acceptance criteria demand a root-cause note; perfect reproduction of intermittent IPC is often not cost-effective.

### 6. Scope boundary with pre-merge

**Choice:** No changes under `core/scripts/stages/pre_merge*` or `pre-merge-ci-gate` living requirements. Cross-link only in proposal/PR.

**Why:** Issue text: this issue is **stop producing the flake**; recovery remains separate.

## Risks / Trade-offs

- **[Risk] Per-file processes slightly increase wall-clock** (Node startup × N files) → **Mitigation:** Only four files today; cost is seconds at most vs human gate cost of flakes.
- **[Risk] Wrapper drift from `npm test` scripts half** → **Mitigation:** Both entry points call the same wrapper/script name; regression asserts both if both exist.
- **[Risk] Flake is actually inside single-file process isolation** → **Mitigation:** Implementation matrix includes running the large `install.test.mjs` alone; if it still deserializes, try `--test-isolation=none` **for that file only** or Node upgrade with documented fix — still structural, not sleep-retry.
- **[Risk] Shared-process fallback pollutes env across files** → **Mitigation:** Prefer per-file top-level processes; if `none` is needed, limit to a single large file process, not the whole glob.
- **[Risk] Operators misread a real install regression as “still the flake”** → **Mitigation:** After fix, failures must show normal `node:test` assertion output; PR note documents the old error signature as eliminated.

## Migration Plan

1. Land runner invocation change + regression test on the issue branch.
2. No data migration; no config keys; no host skill prompt changes required.
3. Rollback: restore previous `package.json` `ci:scripts` line (and remove wrapper if added); regression test will fail intentionally if restored form is the abandoned multi-file IPC path.

## Open Questions

- Confirm during implementation whether the deserialize error can still appear when running **only** `scripts/install.test.mjs` under default isolation (drives whether per-file multi-suite packaging is sufficient or per-file *plus* isolation flags on the large file are required).
- Whether `npm test`'s scripts half must change in the same commit (yes if it shares the flaky invocation — keep local and CI parity).
