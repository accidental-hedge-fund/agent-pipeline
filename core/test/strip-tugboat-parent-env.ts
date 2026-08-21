// Parent Tugboat/FRG processes leak skip-train into `npm test`.
// Inheriting TUGBOAT_SKIP_TRAIN=1 fail-closes ship_one before the scenario
// under test (`FAIL: TUGBOAT_SKIP_TRAIN without train.complete.json or train.json`).

export const TUGBOAT_PARENT_CONTROL_KEYS = [
  "TUGBOAT_SKIP_TRAIN",
  "TUGBOAT_CANDIDATE_COMPOSER",
] as const;

export function stripTugboatParentEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  for (const key of TUGBOAT_PARENT_CONTROL_KEYS) {
    delete env[key];
  }
  return env;
}
