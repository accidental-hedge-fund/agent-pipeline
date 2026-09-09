## Context

#1454 made public-admission persist fail closed unless `resolveFactoryControlRoot(repoDir)` returned a path. That helper only matches when `repoDir` is the live factory-control checkout (or a managed worktree of it). Product repositories never match. `pipeline train --merge` in lyric-utils therefore stopped before any merge.

Factory-control remains a real factory-plane concern: unique-operation collection for FRG must not treat a candidate worktree as the control-host generic store. That collection path stays unchanged.

## Decision

`resolvePublicAdmissionPersistRoot` resolution order:

1. Explicit `factoryControlRoot` overlay. Non-empty string wins. `null` or empty stays fail-closed.
2. Live factory-control identity when `repoDir` is that checkout or a managed worktree of it.
3. Working repository `repoDir`.

Product-repo `pipeline single`, `train --merge`, `merge`, `merge-queue --apply`, and `ship` (which composes `train --merge`) therefore persist under `<repoDir>/.agent-pipeline/runs` with no extra env.

## Consequences

- Product operators run the CLI from the repository they are working on.
- Factory-plane tests that inject `factoryControlRoot: "/control"` still persist in the control store.
- Factory-plane tests that inject `factoryControlRoot: null` still refuse.
- FRG unique-operation collection does not start scoring candidate-worktree run stores.
