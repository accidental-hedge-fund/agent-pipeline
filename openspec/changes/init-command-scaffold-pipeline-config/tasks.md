## 1. Config scaffolding function

- [ ] 1.1 Add `scaffoldDefaultConfig(repoDir: string): Promise<{ created: boolean }>` to `core/scripts/config.ts` that serializes `DEFAULT_CONFIG` as commented YAML and writes `.github/pipeline.yml` only when absent
- [ ] 1.2 Ensure `.github/` directory is created if it does not exist before writing the file
- [ ] 1.3 Return `{ created: false }` (with no file write) if `.github/pipeline.yml` already exists

## 2. CLI init mode

- [ ] 2.1 Add `--init` flag (or `init` sub-command) to the Commander option parser in `core/scripts/pipeline.ts`, dispatched before the issue-number guard — mirroring the `--cleanup` pattern
- [ ] 2.2 Implement `runInit(cfg)` in `pipeline.ts`: call `ensurePipelineLabels(cfg)` then `scaffoldDefaultConfig(cfg.repo_dir)`, print a summary of what was done
- [ ] 2.3 Print a clear notice when the config file already exists and scaffolding was skipped

## 3. Unit tests

- [ ] 3.1 Write test: `ensurePipelineLabels` path — verify it is called during `runInit` (mock `gh` calls)
- [ ] 3.2 Write test: scaffold-config-when-absent — call `scaffoldDefaultConfig` on a temp dir; assert file is created and `created === true`
- [ ] 3.3 Write test: no-clobber-when-present — write a sentinel `.github/pipeline.yml`, call `scaffoldDefaultConfig`; assert file is unchanged and `created === false`
- [ ] 3.4 Write test: scaffolded-config validity — pass the scaffolded file path to `resolveConfig`; assert it returns without throwing and all keys match `DEFAULT_CONFIG`

## 4. Documentation

- [ ] 4.1 Add an "Onboarding a new repo" section to `README.md` showing the `init` invocation and describing what it does (labels + starter config)
- [ ] 4.2 Confirm `pnpm test` passes with all new tests green
