// Static guards for #1333: retired recovery-controller imports, command-local
// lifecycle exits, direct stage-label writes from command modules, and
// provider/incident-string dispatch in production recovery routing.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPERVISED_COMMAND_MODULES } from "./command-form-inventory.ts";

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
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/process\.exit\s*\(\s*1\s*\)/.test(lines[i]!)) continue;
    const start = Math.max(0, i - 2);
    const end = Math.min(lines.length, i + 3);
    const window = lines.slice(start, end).join("\n");
    if (/mechanical|recovery|exhaust/.test(window)) {
      hits.push({ file, reason: "command-local lifecycle process.exit on a mechanical fault" });
    }
  }
  return hits;
}

export const RECOVERY_WRITE_IDENTIFIERS = [
  "writeRecoveryEpisode",
  "createRecoveryEpisode",
  "cancelRecoveryEpisode",
  "updateRecoveryEpisode",
] as const;

export function collectReadOnlyRecoveryWrites(source: string, file = "fixture.ts"): StaticGuardHit[] {
  const hits: StaticGuardHit[] = [];
  for (const id of RECOVERY_WRITE_IDENTIFIERS) {
    const re = new RegExp(`\\b${id}\\s*\\(`);
    if (re.test(source)) {
      hits.push({ file, reason: `read-only form writes recovery state via ${id}` });
    }
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

const CLASSIFIER_IMPORT_RE =
  /from\s+["'][^"']*(?:typed-request-resolution|grill-settle)[^"']*["']/;
const CLASSIFIER_INVOCATION_RE =
  /\b(?:resolveTypedRequest|classifyHumanAsk|settleRecommendation)\s*\(/;
const HUMAN_ASK_PARK_RE =
  /\bwaitItem\s*\(|disposition:\s*["']human_authority["']/;

/**
 * Production park sites for human asks must import the shared classifier.
 * stage-diagnostic coarse projection and recovery-policy compilation are
 * not park sites.
 */
export function collectHumanAskWithoutClassifier(source: string, file = "fixture.ts"): StaticGuardHit[] {
  if (file.endsWith("stage-diagnostic.ts") || file.endsWith("loop/recovery.ts") || file.endsWith("recovery.ts")) {
    return [];
  }
  if (!HUMAN_ASK_PARK_RE.test(source)) return [];
  if (CLASSIFIER_IMPORT_RE.test(source)) return [];
  return [{ file, reason: "production human-ask park without shared classifier import" }];
}

const NEEDS_HUMAN_STAGE_PARK_RE =
  /transition(?:Fn)?\s*\(\s*[^,]+,\s*[^,]+,\s*["'][^"']+["']\s*,\s*["']needs-human["']|to:\s*["']needs-human["']|addLabels?\s*\([^;]{0,400}["']pipeline:needs-human["']/;

/**
 * Production sites must not park `pipeline:needs-human` as human ownership
 * without the shared typed-request classifier. Recovery modules are not
 * exempt: a park is allowed only when the file imports the classifier and
 * an invocation sits adjacent to that park. design_gate.ts is bound by
 * recovery-lifecycle-ownership class law (change D6) rather than rewritten here.
 */
function everyNeedsHumanParkHasAdjacentClassifier(source: string): boolean {
  const lines = source.split("\n");
  let parkFound = false;
  for (let i = 0; i < lines.length; i++) {
    if (!NEEDS_HUMAN_STAGE_PARK_RE.test(lines[i]!)) continue;
    parkFound = true;
    const start = Math.max(0, i - 8);
    const end = Math.min(lines.length, i + 9);
    if (!CLASSIFIER_INVOCATION_RE.test(lines.slice(start, end).join("\n"))) {
      return false;
    }
  }
  return parkFound;
}

export function collectNeedsHumanParkWithoutClassifier(source: string, file = "fixture.ts"): StaticGuardHit[] {
  if (
    file.endsWith("stage-diagnostic.ts") ||
    file.endsWith("design_gate.ts") ||
    file.endsWith("types.ts")
  ) {
    return [];
  }
  if (!NEEDS_HUMAN_STAGE_PARK_RE.test(source)) return [];
  if (CLASSIFIER_IMPORT_RE.test(source) && everyNeedsHumanParkHasAdjacentClassifier(source)) return [];
  return [{ file, reason: "production needs-human park without shared classifier import" }];
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
    hits.push(...collectHumanAskWithoutClassifier(source, rel));
    hits.push(...collectNeedsHumanParkWithoutClassifier(source, rel));
    const supervisedRel = SUPERVISED_COMMAND_MODULES.filter((m) => m !== "scripts/pipeline.ts");
    if (rel.startsWith(COMMAND_MODULE_DIR) || supervisedRel.includes(rel as (typeof supervisedRel)[number])) {
      hits.push(...collectCommandLocalLifecycleExits(source, rel));
    }
    if (rel.startsWith(COMMAND_MODULE_DIR)) {
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
