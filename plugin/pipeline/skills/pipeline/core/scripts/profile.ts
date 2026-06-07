import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "./types.ts";

export type ReviewMode = "claude-companion" | "codex-companion" | "prompt-harness";

export interface PipelineProfile {
  name: "codex" | "claude" | "openclaw" | string;
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

export function loadProfile(name = "codex"): PipelineProfile {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid pipeline profile: ${name}`);
  const profilePath = path.join(RELEASE_ROOT, "profiles", `${name}.json`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Unknown pipeline profile '${name}'. Expected ${profilePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8")) as PipelineProfile;
  if (!parsed.harnesses?.implementer || !parsed.harnesses?.reviewer || !parsed.reviewMode) {
    throw new Error(`Invalid pipeline profile '${name}': missing harnesses/reviewMode`);
  }
  return parsed;
}
