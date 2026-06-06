// Optional pre-planning context from the external `last30days` skill
// (https://github.com/mvanhorn/last30days-skill). It aggregates the last 30 days
// of public discourse for a topic (Reddit/X/YouTube/HN/GitHub/…) into an
// evidence brief. OPT-IN (`last30days.enabled`, default false): the skill is a
// separate Python toolchain with optional API keys and only adds value for
// product/topic-flavored issues. Absence or failure is always non-blocking —
// the pipeline just plans without the extra context.
//
// We invoke the documented headless form and read the machine-readable
// `--emit=compact` evidence block off stdout:
//   python3 <skill>/scripts/last30days.py "<topic>" --emit=compact --save-dir=<tmp> --auto-resolve
// `extractBrief` is PURE and unit-tested without the skill installed.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PipelineConfig } from "./types.ts";

const EVIDENCE_START = "<!-- EVIDENCE FOR SYNTHESIS -->";
const EVIDENCE_END = "<!-- END EVIDENCE FOR SYNTHESIS -->";

export interface BriefResult {
  brief: string; // the evidence block (empty if none/failed)
  stats: string; // footer per-source counts line (empty if none)
  success: boolean; // CLI exited 0
  unavailable: boolean; // skill dir or python interpreter not found
}

export function isEnabled(cfg: Pick<PipelineConfig, "last30days">): boolean {
  return Boolean(cfg.last30days?.enabled);
}

/** Locate the installed last30days skill dir (one containing scripts/last30days.py). */
export function skillDir(): string | null {
  const candidates = [
    process.env.LAST30DAYS_SKILL_DIR,
    path.join(os.homedir(), ".claude", "skills", "last30days"),
    path.join(os.homedir(), ".codex", "skills", "last30days"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "scripts", "last30days.py"))) return c;
  }
  return null;
}

/** Run the skill headlessly for `topic`. Never throws; returns a BriefResult. */
export async function run(
  topic: string,
  opts: { timeoutSec?: number } = {},
): Promise<BriefResult> {
  const dir = skillDir();
  if (!dir) return { brief: "", stats: "", success: false, unavailable: true };

  const python = process.env.LAST30DAYS_PYTHON || "python3";
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "last30days-"));
  const args = [
    path.join(dir, "scripts", "last30days.py"),
    topic,
    "--emit=compact",
    "--save-dir",
    saveDir,
    "--auto-resolve",
  ];
  const timeoutSec = opts.timeoutSec ?? 600;

  return new Promise<BriefResult>((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (r: BriefResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best effort */
      }
    }, timeoutSec * 1000);
    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length < 500_000) stdout += c.toString("utf8");
    });
    // ENOENT (python missing) and other spawn failures arrive here.
    child.on("error", () => {
      clearTimeout(timer);
      finish({ brief: "", stats: "", success: false, unavailable: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ ...extractBrief(stdout), success: code === 0, unavailable: false });
    });
  });
}

/** Pure: pull the evidence block + footer stats out of `--emit=compact` stdout. */
export function extractBrief(stdout: string): { brief: string; stats: string } {
  const s = stdout ?? "";
  let brief = "";
  const start = s.indexOf(EVIDENCE_START);
  const end = s.indexOf(EVIDENCE_END);
  if (start !== -1 && end !== -1 && end > start) {
    brief = s.slice(start + EVIDENCE_START.length, end).trim();
  }
  // Footer stats: a machine-readable per-source counts line, e.g.
  // "🌐 Reddit: 12 items | 🐦 X: 8 items | 📺 YouTube: 3 items".
  let stats = "";
  for (const line of s.split("\n")) {
    if (/\bitems\b/i.test(line) && line.includes("|")) {
      stats = line.trim();
      break;
    }
  }
  return { brief, stats };
}

/** Whether a brief carries enough signal to be worth carrying forward. */
export function hasSignal(brief: string): boolean {
  const b = (brief ?? "").trim();
  return b.length > 0 && /cluster|^###|\n###/im.test(b);
}
