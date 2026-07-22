## 1. Pin the evidence

- [ ] 1.1 Record the reproduction in the change: launch `pipeline <N> --detach` from an empty
      non-repo directory on the pre-fix code and capture launcher exit code, stdout, the
      created `~/.pipeline/runs/<N>/<ts>/` contents, and the sentinel `exitCode`.
- [ ] 1.2 Confirm no other caller depends on the `findGitRoot(...) ?? start` fallback in the
      detach path (`grep -rn "findGitRoot" core/scripts/`).

## 2. Launcher precondition

- [ ] 2.1 In `handleRunSubcommand` (`core/scripts/pipeline.ts`), move repo resolution above
      run-id pinning and `spawnDetached`: start dir = resolved `--repo-path` else cwd.
- [ ] 2.2 On unresolved repo, print
      `pipeline: no git repo found at or above <startDir>. Run from inside a checkout, or pass --repo-path.`
      set exit code 2, and return before any write or spawn.
- [ ] 2.3 Delete the `?? runStoreStart` fallback; derive `runStoreDir` from the resolved root
      only.

## 3. Test seam

- [ ] 3.1 Extend `RunSubcommandDeps` with the git-root resolution (and start-dir source) so
      tests can drive resolution outcomes without touching a real filesystem or git.
- [ ] 3.2 Keep the default deps wired to the real `findGitRoot`/`process.cwd`, so runtime
      behavior for resolvable repos is unchanged.

## 4. Regression tests (`core/test/`)

- [ ] 4.1 Unresolved repo → exit code 2, injected `spawnDetached` never called, no
      "detached run started" output.
- [ ] 4.2 Unresolved repo → no filesystem write at all (assert against a temp dir that stays
      empty and an injected writer that is never invoked).
- [ ] 4.3 `--repo-path <non-repo>` → refusal naming the resolved `--repo-path` value.
- [ ] 4.4 Resolvable repo, launch from a subdirectory → run-store dir is
      `<git-root>/.agent-pipeline/runs/<run-id>`, `spawnDetached` still called with the same
      forwarded args (`--run-id`, `--json-events`, lifecycle flags) and exit code 0.
- [ ] 4.5 Prove 4.1/4.2 bite: they fail against the pre-fix ordering.

## 5. Ship

- [ ] 5.1 Regenerate the mirror: `node scripts/build.mjs`, commit `plugin/` in the same change.
- [ ] 5.2 `npm run ci` green from the repo root.
- [ ] 5.3 Update the change tasks/proposal checkboxes and archive per the pre-merge flow.
