import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "./types.ts";

export type ReviewMode = "prompt-harness";

export interface PipelineProfile {
  name: "codex" | "claude" | string;
  displayName: string;
  invocation: string;
  harnesses: { implementer: Harness; reviewer: Harness };
  reviewMode: ReviewMode;
  markerFooter: string;
  implementationReadyMessage: string;
  conventionsDefault: string;
  notifications?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_ROOT = path.resolve(__dirname, "..");

export function loadProfile(
  name = "codex",
  profilesDir = path.join(RELEASE_ROOT, "profiles"),
): PipelineProfile {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid pipeline profile: ${name}`);
  const profilePath = path.join(profilesDir, `${name}.json`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Unknown pipeline profile '${name}'. Expected ${profilePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8")) as PipelineProfile;
  if (!parsed.harnesses?.implementer || !parsed.harnesses?.reviewer || !parsed.reviewMode) {
    throw new Error(`Invalid pipeline profile '${name}': missing harnesses/reviewMode`);
  }
  // Runtime guard, not just a type: the companion review modes were removed
  // (#93) and types are stripped, not checked.
  if (parsed.reviewMode !== "prompt-harness") {
    throw new Error(
      `Invalid pipeline profile '${name}': reviewMode '${parsed.reviewMode}' is not supported (only "prompt-harness")`,
    );
  }
  return parsed;
}
