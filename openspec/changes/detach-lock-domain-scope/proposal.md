## Why

Advance serializes on a host-local PID lock keyed by **domain + issue**
(`/tmp/pipeline-{domain}-{N}.lock`), but detach serializes on a home-dir lock keyed by
**issue number alone** (`~/.pipeline/runs/<issue>/.lock`). Two different repositories that
happen to share an issue number (e.g. both have issue 42) therefore share one detach lock,
while each has its own advance lock — and foreground advance never observes the detach path,
so the two entry points can race. Dual lock systems with different scopes are an invitation
to dual-entry races for multi-repo operators on one host.

## What Changes

- **Unify the issue-run mutex.** Introduce (or consolidate onto) one host-local lock API
  keyed by `(domain, issueNumber)` — the same identity advance already uses — and route
  **both** foreground advance and detach through it so same-domain same-issue work is
  mutually exclusive regardless of entry path.
- **Domain-scope the detach lock path.** Detach MUST include domain (or an equivalent
  repo/domain identity already used by advance) in its lock key/path so issue `N` in
  domain A never collides with issue `N` in domain B on the same host.
- **Close the dual-entry race.** A live holder of the unified lock blocks both a second
  detach and a concurrent foreground advance for that same `(domain, issue)`, and vice
  versa. Different domains or different issue numbers remain concurrent.
- **Document host-local scope (no cross-host claim).** The unified lock remains a
  single-host primitive (same engineering disposition as #459 / `cross-host-concurrency-scope`).
  Project docs and the concurrency-scope capability state that explicitly for the unified
  issue-run lock; distributed/cross-host locking is out of scope.
- **Regression tests.** Unit tests prove: (1) same issue number under two domains does not
  collide; (2) same domain + issue is exclusive across advance and detach entry points;
  (3) different issue numbers under one domain still run concurrently. I/O is injected —
  no real network, git, or subprocess.
- **Mirror + gate.** After implementation, regenerate `plugin/` via `node scripts/build.mjs`
  and keep `npm run ci` green.

## Capabilities

### New Capabilities
- `issue-run-lock`: Host-local mutual exclusion for an issue run, keyed by `(domain, issue)`,
  shared by foreground advance and detach; documents single-host scope and non-collision
  across domains for the same issue number.

### Modified Capabilities
- `detached-launcher`: Detach advisory lock and related path helpers include domain/repo
  identity; concurrent-launch rejection and handshake semantics apply per `(domain, issue)`,
  not bare issue number; mutual exclusion with foreground advance for that key.
- `cross-host-concurrency-scope`: Host-local lock assessment/docs include the unified
  issue-run lock (advance + detach) and reaffirm single-host as the supported concurrency
  scope — no new cross-host coordination service.
- `loop-live-advance-coexistence`: Live-advance probes that observe the per-issue lock or
  detach markers resolve those paths with the same domain-scoped identity so probes match
  the unified lock key (behavior unchanged for same-domain same-issue; no cross-domain
  false positives).

## Acceptance Criteria

- [ ] Detach lock identity includes domain (or the same domain key advance already uses);
      lock path/key is never issue-number-only.
- [ ] Issue `N` under domain A and issue `N` under domain B can both hold their locks on
      the same host without mutual exclusion (cross-repo issue-number non-collision).
- [ ] Foreground advance and detach for the same `(domain, issue)` share one mutex: a
      live holder of either entry rejects or blocks the other for that key (no dual-entry
      race window from separate lock systems).
- [ ] Different issue numbers under the same domain still run concurrently (no domain-wide
      serialization regression for the per-issue path).
- [ ] Project docs (and the concurrency-scope capability) state that the unified issue-run
      lock is host-local; no claim of cross-host mutual exclusion is introduced.
- [ ] Unit tests cover cross-domain non-collision, same-key advance↔detach exclusion, and
      different-issue concurrency, via injected seams (no real network/git/subprocess).
- [ ] `npm run ci` passes (core tests, `plugin/` mirror sync, install smoke, openspec
      validate when applicable).

## Impact

- `core/scripts/lock.ts` — unified issue-run lock API / path construction; possibly shared
  acquire/release used by advance.
- `core/scripts/detach.ts` — `issueRunsDir` / `lockFilePath` / wrapper acquire path gain
  domain (or equivalent) identity; spawn/wrapper handshake continues to own the lock for
  the wrapper lifetime.
- `core/scripts/pipeline-run.ts` (and any other advance entry) — acquire the unified lock
  so detach and advance cannot dual-enter the same issue.
- `core/scripts/loop/live-advance.ts` (and callers) — resolve lock/marker paths with
  domain so coexistence probes stay aligned.
- Co-located tests under `core/test/` (detach, lock, live-advance, loop coexistence as
  needed).
- Project docs (`CLAUDE.md` / `AGENTS.md` / concurrency notes) for host-local scope of the
  unified lock.
- Generated `plugin/` mirror after core edits.

**Out of scope:** cross-host distributed locks; changing the auto-file GitHub-truth path
(#459); autonomous merge / new coordination services.
