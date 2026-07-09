## Context

`createWorktree` (`core/scripts/worktree.ts`) performs three git operations that mutate the
shared repo's common directory (`.git` metadata shared by all linked worktrees):

1. `git fetch origin <base_branch>` — updates `refs/remotes/origin/<base>`.
2. `git branch -D <branch>` — deletes a leftover branch.
3. `git worktree add … -b <branch> origin/<base>` — writes `.git/config` + creates the worktree.

v1.2.2 (#183, capability `worktree-creation-concurrency`) hardened **only** step 3 against
`.git/config.lock` contention with a per-repo mutex (keyed on the canonical Git common directory
so runs from different linked worktrees share one mutex) plus a bounded config-lock retry. Steps
1–2 run outside that mutex. Step 1 is the fetch that races: two concurrent fetches both try to
update `refs/remotes/origin/<base>`, and git takes a ref lock (`.git/refs/remotes/origin/<base>.lock`)
for the final ref update. The loser sees `cannot lock ref … is at <new> but expected <old>` and,
because the fetch uses `ignoreFailure: false`, the wrapped error blocks the run at planning.

## Goals / Non-Goals

**Goals**
- Concurrent base-branch fetches of the same repo never convert a run into a blocked run.
- Non-contention fetch failures (auth/network/missing remote) still fail fast and visibly.
- Deterministic, timer-free unit coverage via the existing dependency-injection seams.

**Non-Goals**
- Serializing git operations that are already safe or already serialized.
- Changing the fetch cadence or targets of planning.
- A global (cross-repo) lock — the mutex remains per-repo, keyed on the common directory.

## Decision: serialize under the existing mutex **and** add a scoped retry

Two mechanisms, matching exactly what step 3 already does — reusing the established pattern rather
than inventing a parallel one ("existing conventions win").

**Primary — serialize.** Move the mutex acquisition to before the fetch so the critical section is
`{ fetch → branch -D → worktree add }`. Both racing fetches go through `createWorktree`, so a
shared per-repo mutex deterministically prevents the overlap that causes the ref-lock race — no
retries needed in the common case. The mutex is already keyed on the canonical common directory, so
two runs launched from different linked worktrees of the same repo serialize correctly.

**Belt-and-suspenders — retry.** A ref lock can also be left by a git process the mutex cannot see:
a crashed pipeline git, or a developer running `git fetch` by hand in the same repo. So, mirroring
the config-lock retry on `git worktree add`, wrap the fetch in a bounded retry scoped to the
ref-lock stderr signature. The retry adds randomized **jitter** (per the issue) so that if two
uncoordinated fetchers do collide, they don't lock-step into repeated collisions.

### Why not retry-only (no serialization)?

Retry-only is the lighter change and is explicitly allowed by the acceptance criteria, but it can
theoretically exhaust under heavy simultaneous dispatch (N runs all retrying into the same tiny
ref-update window). Serialization removes the race deterministically for pipeline-originated runs;
retry then only has to cover the rare external/crashed-git holder. Doing both is the same shape as
the already-shipped step-3 hardening, so the code stays uniform and the mutex machinery is reused,
not duplicated.

### Why not serialization-only (no retry)?

The mutex only coordinates pipeline runs that call `createWorktree`. It cannot serialize against a
manual `git fetch` or a crashed git holding a stale ref lock. The scoped retry closes that gap, and
is nearly free since the ref-update window is tiny.

## Ref-lock signature (scoping the retry)

Retry only when the fetch exits non-zero **and** stderr contains `cannot lock ref` or `unable to
update local ref`. Everything else (`could not read Username`, `Could not resolve host`, `fatal:
'origin' does not appear to be a git repository`) throws immediately with the underlying stderr,
preserving today's `git fetch origin <base> failed: <stderr>` shape. The signature is a substring
match on stderr, consistent with the existing `stderr.includes("could not lock config file")` check
for `git worktree add`.

## Mutex hold-time / timeout

Extending the critical section over a network fetch lengthens the maximum hold time. The git
subprocess timeout is 60 s (`worktree.ts` `git()` default). With fetch + add both inside the
section, a holder can occupy the mutex for up to ~fetch(≤60 s) + add(≤60 s). The current
`MUTEX_TIMEOUT_MS` (90 s) assumes an add-only holder; it must be widened so a waiter does not
give up while a legitimate holder is mid-fetch-then-add. Size the wait to cover both subprocess
timeouts plus margin. This is a tuning constant, not a behavioral contract, but the requirement
records that the wait must not expire before a single live holder can finish its fetch **and** add.

## Testing seam

`gitCmd` (already injectable) simulates fetch outcomes by branching on `args[0] === "fetch"`.
`sleep` is already injectable; add a `jitter` source to `CreateWorktreeDeps` so backoff is
deterministic in tests and the retry path never calls `Math.random` directly (the repo avoids
non-deterministic calls in logic under test). The regression test injects a first-attempt ref-lock
failure + second-attempt success and asserts a clean return with no real timer — it fails without
the retry loop, proving the test bites.
