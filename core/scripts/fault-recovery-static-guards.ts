// Static guards for #1333: retired recovery-controller imports, command-local
// lifecycle exits, direct stage-label writes from command modules, and
// provider/incident-string dispatch in production recovery routing.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const RETIRED_RECOVERY_CONTROLLERS = [
  "legacy-recovery-controller",
  "command-local-recovery",
  "retired-recovery-controller",
] as const;

export const PROVIDER_OR_INCIDENT_DISPATCH_KEYS = [
  "GitHub Actions failed",
  "merge conflict with origin/main",
  "copilot-gpt",
  "openai-provider",
  "worktree locked by claude-3",
] as const;

const COMMAND_MODULE_DIR = "scripts/stages";

function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "test" || name === "evals") continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (name.endsWith(".ts")) out.push(abs);
    }
  }
  return out;
}

export interface StaticGuardHit {
  file: string;
  reason: string;
}

export function collectRetiredControllerImports(source: string, file = "fixture.ts"): StaticGuardHit[] {
  const hits: StaticGuardHit[] = [];
  for (const name of RETIRED_RECOVERY_CONTROLLERS) {
    const re = new RegExp(`from\\s+["'][^"']*${name}[^"']*["']|import\\(["'][^"']*${name}[^"']*["']\\)`);
    if (re.test(source)) {
      hits.push({ file, reason: `retired recovery-controller import: ${name}` });
    }
  }
  return hits;
}

export function collectCommandLocalLifecycleExits(source: string, file = "fixture.ts"): StaticGuardHit[] {
  const hits: StaticGuardHit[] = [];
  if (/process\.exit\s*\(/.test(source) && /mechanical|recovery|exhaust/.test(source)) {
    hits.push({ file, reason: "command-local lifecycle process.exit on a mechanical fault" });
  }
  return hits;
}

const DIRECT_LABEL_WRITE_RE =
  /(?:addLabel|addLabels|ghAddLabel)\s*\([^;]{0,400}["']pipeline:(needs-human|blocked|ready-to-deploy|ready|implementing|planning|review|in-progress|fix)["']/;
const SET_BLOCKED_LIFECYCLE_RE =
  /setBlocked\s*\([^;]{0,500}["']pipeline:(needs-human|blocked|ready-to-deploy)["']/;

export function collectDirectStageLifecycleWrites(source: string, file = "fixture.ts"): StaticGuardHit[] {
  const hits: StaticGuardHit[] = [];
  if (DIRECT_LABEL_WRITE_RE.test(source)) {
    hits.push({ file, reason: "direct stage lifecycle label write from a command module" });
  }
  if (SET_BLOCKED_LIFECYCLE_RE.test(source)) {
    hits.push({ file, reason: "direct needs-human write from a command module" });
  }
  return hits;
}

export function collectProviderIncidentDispatch(source: string, file = "fixture.ts"): StaticGuardHit[] {
  const hits: StaticGuardHit[] = [];
  for (const key of PROVIDER_OR_INCIDENT_DISPATCH_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
    const re = new RegExp(`case\\s+["']${escaped}["']|["']${escaped}["']\\s*:`);
    if (re.test(source)) {
      hits.push({ file, reason: `provider or incident string dispatch key: ${key}` });
    }
  }
  return hits;
}

export function scanProductionRecoveryGuards(coreRoot?: string): StaticGuardHit[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = coreRoot ?? join(here, "..");
  const scriptsRoot = join(root, "scripts");
  const hits: StaticGuardHit[] = [];
  for (const abs of walkTsFiles(scriptsRoot)) {
    const rel = relative(root, abs);
    const source = readFileSync(abs, "utf8");
    hits.push(...collectRetiredControllerImports(source, rel));
    if (rel.startsWith(COMMAND_MODULE_DIR)) {
      hits.push(...collectCommandLocalLifecycleExits(source, rel));
      hits.push(...collectDirectStageLifecycleWrites(source, rel));
    }
    if (
      rel.includes("escalation-classify") ||
      rel.includes("loop/recovery") ||
      rel.includes("auto_recover") ||
      rel.includes("fault-recovery-matrix")
    ) {
      hits.push(...collectProviderIncidentDispatch(source, rel));
    }
  }
  return hits;
}

/**
 * Command-local retry/STOP sites mapped to replacement matrix rows before
 * deletion (#1333 task 8.1). Live strategy-cursor exhaustion now records
 * Cooling in loop/supervisor.ts rather than a terminal `recovery_exhausted`
 * stop.
 */
export const LEGACY_LIFECYCLE_SITE_INVENTORY = [
  {
    site_id: "loop.supervisor.recovery_exhausted_stop",
    module: "scripts/loop/supervisor.ts",
    replacement_row: "adapter contract: strategy_exhaustion",
    status: "replaced_with_cooling",
  },
] as const;
