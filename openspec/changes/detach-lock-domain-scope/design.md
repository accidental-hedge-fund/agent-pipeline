## Context

Today the engine has **two** host-local lock implementations for “this issue is running”:

| Entry | Module | Key | Path shape |
|---|---|---|---|
| Foreground advance | `lock.ts` (`PipelineLock` / `withLock`) | `domain` + optional `issueNumber` | `/tmp/pipeline-{domain}-{N}.lock` |
| Detach wrapper | `detach.ts` (`lockFilePath` / `acquireLock`) | **issue number only** | `~/.pipeline/runs/<N>/.lock` |

Evidence:

- Advance: `core/scripts/lock.ts`, acquired from `pipeline-run.ts` via `withLock(cfg.domain, …, issueNumber)`.
- Detach: `core/scripts/detach.ts` `issueRunsDir(homedir, issue)` → `…/runs/<issue>/.lock`; wrapper acquires before work; launcher waits on handshake.
- Live probes: `core/scripts/loop/live-advance.ts` reads the **issue-only** detach path when looking for wrapper/lock evidence.

Failure modes on a multi-repo host:

1. **Cross-repo collision.** Detach for repo A #42 and repo B #42 share one lock file; one falsely blocks the other (or worse, run-dir artifacts interleave under the same issue folder).
2. **Dual-entry race.** Foreground advance does not check the detach lock path, and detach does not acquire the advance lock. Same domain + issue can run both paths at once until one hits GitHub/worktree contention.

#459 / `cross-host-concurrency-scope` already declared single-host scope for `/tmp` PID locks and exempted the auto-file GitHub-truth path. This change stays inside that doctrine: fix **same-host multi-repo and dual-entry** correctness; do **not** introduce cross-host distributed locks.

## Goals / Non-Goals

**Goals:**

- One lock **identity** `(domain, issueNumber)` for both advance and detach.
- One lock **API surface** (or a thin shared helper) both entry points call, so a second implementation cannot drift on scope again.
- Cross-domain same issue number: no mutual exclusion.
- Same domain + issue: mutual exclusion across foreground and detach.
- Document host-local scope for the unified lock.
- Tests that would have failed under today’s issue-only detach path.

**Non-Goals:**

- Cross-host / multi-machine mutual exclusion.
- Changing auto-file cross-host safety (#459 / papercut path).
- Domain-wide (issue-less) legacy lock behavior beyond keeping it working for callers that still omit `issueNumber`.
- Redesigning run-store layout under `.agent-pipeline/runs/` (repo-root contract stays).
- Auto-merge or any new coordination service.

## Decisions

### 1. Lock key = advance’s existing `domain` + `issueNumber`

**Decision:** Use `domain` (the same string `withLock` / `PipelineLock` already takes — typically repo basename or `--domain` override) as the non-issue half of the key. Do not introduce a second “repo slug” unless it is proven equal to domain at every call site.

**Rationale:** Unifying means detach must speak advance’s language. Adding `owner/name` as a second axis would either double-key (still colliding when domain differs) or force a migration of every advance call site. Operators already isolate multi-repo work with domain; config already surfaces it.

**Alternatives considered:**

- Key by `owner/name` from `cfg.repo`. Better for multi-clone same-repo identity, but advance does not use it today; changing advance key is a larger, riskier migration than this issue requires.
- Key by absolute repo path. Breaks when the same logical checkout is reached via different paths; worse than domain.

### 2. Shared API in `lock.ts`; detach becomes a consumer

**Decision:** Export a single issue-run lock constructor/helper from `lock.ts` (extend `PipelineLock` / `withLock` or a clearly named `IssueRunLock` wrapper) that **requires** `domain` + `issueNumber` for the per-issue path. Detach’s private `tryWriteLock` / `acquireLock` / path helpers call into that API (or share path construction + acquire/release) rather than maintaining a parallel PID file protocol.

**Rationale:** The bug is dual systems. Sharing only a path string while keeping two acquire implementations still invites handshake/stale-PID divergence. One acquire/release implementation, two call sites.

**Process-identity markers:** Detach today writes `pid starttime` for #770 recycled-PID safety; advance’s `PipelineLock` writes bare PID. When consolidating:

- Prefer **preserving** the stronger `pid [starttime]` body for the unified issue-run lock so live-advance coexistence probes keep working.
- Or keep detach’s marker write as a thin layer **on top of** the same path if the shared primitive stays bare-PID — but then document that coexistence probes must still validate process identity where detach markers are used.

Prefer the first (stronger marker on the shared path) unless tests prove bare-PID is required for advance.

### 3. Canonical path for the unified per-issue lock

**Decision:** Prefer **one filesystem path** for the per-issue mutex so dual-entry is structurally impossible:

- Primary candidate: keep advance’s `/tmp/pipeline-{domain}-{N}.lock` as the **mutex**, and stop using `~/.pipeline/runs/<N>/.lock` as a second mutex.
- Detach wrapper run directories and logs can remain under a **domain-scoped** home path (e.g. `~/.pipeline/runs/<domain>/<N>/…`) for artifact isolation, with the mutex itself on the `/tmp` path (or vice versa — one path only).

**Rationale:** Two paths that both must be acquired is still a dual system. One path acquired by both entry points closes the race without a two-phase lock.

**Alternatives considered:**

- Only domain-scope the home-dir lock and leave advance on `/tmp` (two paths, acquire both). Rejected: easy to miss one call site; TOCTOU between acquires.
- Only document “operators must not multi-repo on one host.” Rejected: issue requires a real fix and tests.

**Wrapper run-dir layout:** Domain-scope `issueRunsDir` when changing lock helpers so run artifacts for A#42 and B#42 do not share a directory even if the mutex lives under `/tmp`. That is a necessary companion of domain-scoped identity for detach artifacts; it is not a redesign of `.agent-pipeline/runs/`.

### 4. Call-site wiring

| Caller | Behavior after change |
|---|---|
| `pipeline-run.ts` `withLock` | Same domain + issueNumber; shared primitive (marker body may strengthen). |
| Detach wrapper / `spawnDetached` | Pass domain (from resolved config / repo basename / `--domain`) into path + acquire; handshake unchanged in spirit. |
| `live-advance.ts` probes | Resolve lock/marker with domain so “live for this issue” means this domain’s issue. |
| Loop coexistence | No policy change; path resolution gains domain so cross-repo false live is avoided. |

Domain MUST be available before detach creates lock or run-dir artifacts. Detach already resolves the repo before writing artifacts (`detached-launcher`); domain can be derived at that point (config load / basename of resolved root / explicit `--domain`).

### 5. Host-local scope documentation

**Decision:** Treat the unified issue-run lock as another row in the #459 assessment table: host-local, single-host supported scope, cross-host failure = two hosts each advance the same issue in their own worktrees (last-writer-wins on labels), not a new irreversible shared artifact. Update `cross-host-concurrency-scope` and project docs to name the unified lock (advance + detach) rather than only “advance lock”.

**Non-decision:** No GitHub lease, no Redis, no flock over NFS claims.

### 6. Stale legacy path handling

**Decision:** Do not auto-migrate or delete old `~/.pipeline/runs/<N>/.lock` files beyond optional best-effort documentation. New code never creates issue-only lock paths. Operators with a stuck pre-change lock remove it manually if needed (same as today’s stale-lock ops).

## Risks / Trade-offs

- **[Risk] Marker body change breaks a probe that expects bare PID only** → Mitigation: keep coexistence tests that read markers; assert both advance and detach produce a probe-visible live identity; prove recycled-PID rejection still holds (#770).
- **[Risk] Domain mismatch** (advance uses basename, detach uses `owner-name` or config domain override inconsistently) → Mitigation: single helper that derives domain the same way as `loadConfig` / `withLock` callers; tests pass the same string both paths use.
- **[Risk] In-flight detached runs under old path during upgrade** → Mitigation: accept one-time operator interruption; document that issue-only paths are obsolete; no dual-read of old+new forever (that reintroduces dual systems).
- **[Trade-off] Home-dir run layout changes** (`…/runs/<domain>/<N>/`) may break external scripts that hard-code issue-only paths → Mitigation: prefer one documented layout; note in proposal impact; keep mutex identity tests independent of home layout if mutex is under `/tmp`.
- **[Trade-off] Stronger process-identity markers on advance lock** slightly changes on-disk format → Mitigation: readers already parse `pid` as first token; starttime is additive.

## Migration Plan

1. Land API + path helpers + call sites + tests in one change; regenerate `plugin/`.
2. No data migration of historical run dirs required for correctness of *new* runs.
3. Rollback: revert the change; operators clean stale locks under both layouts if needed.

## Open Questions

None blocking the proposal. Implementation may choose mutex path under `/tmp` vs domain-scoped home path as long as:

1. the key is always `(domain, issue)`,
2. both entry points use the same path and API,
3. tests prove non-collision and dual-entry exclusion.

Prefer `/tmp/pipeline-{domain}-{N}.lock` as the single mutex to minimize advance churn.
