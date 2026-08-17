// Shared Factory Reliability Gate (FRG) skip resolution for
// `pipeline release` and `pipeline engine-promote` (#1092).
//
// Precedence: explicit CLI `--skip-frg` skips (source `cli`); else
// `.github/pipeline.yml` `skip_frg: true` skips (source `config`);
// else FRG is required. Config cannot cancel an explicit CLI skip.

export type FrgSkipSource = "cli" | "config";

export interface FrgSkipResolution {
  skip: boolean;
  source: FrgSkipSource | null;
}

export function resolveFrgSkip(input: {
  cliSkip?: boolean;
  configSkip?: boolean;
}): FrgSkipResolution {
  if (input.cliSkip === true) return { skip: true, source: "cli" };
  if (input.configSkip === true) return { skip: true, source: "config" };
  return { skip: false, source: null };
}

/** Wording for the skip log. CLI stays `--skip-frg`; config names the yml key. */
export function formatFrgSkipReason(source: FrgSkipSource): string {
  if (source === "cli") return "--skip-frg";
  return "skip_frg: true in .github/pipeline.yml";
}
