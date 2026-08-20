// Collect hybrid-v2 pack provenance for factory-gate --from-run (#1118).
// Injectable I/O. Production default uses gh + TAP on the candidate checkout.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  collectFrgPackObservations,
  defaultFrgPackRoot,
  loadFrgPack,
  type CollectedFrgObservations,
  type LoadedFrgPack,
  type VerifiedFrgPackRun,
} from "./frg-pack-observations.ts";
import type { LoopContract, LoopLedger } from "./loop/types.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(canonical);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
      output[key] = canonical((entry as Record<string, unknown>)[key]);
    }
    return output;
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, opts.timeoutMs ?? 30 * 60 * 1000);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export interface HybridV2FromRunArgs {
  repoDir: string;
  version: string;
  fromRun: string;
  contract: LoopContract;
  ledger: LoopLedger;
}

export interface HybridV2FromRunDeps {
  loadPack?: () => Promise<LoadedFrgPack>;
  gitHead?: (repoDir: string) => Promise<string>;
  ghJson?: (args: string[]) => Promise<unknown>;
  runProbe?: (
    probe: { id: string; test_file: string; test_name: string },
    input: { repoDir: string; candidateGitSha: string },
  ) => Promise<VerifiedFrgPackRun["probes"][number]>;
}

function itemNumbers(contract: LoopContract): number[] {
  return contract.items.map((item) => Number(item.id));
}

const GREEN_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

/** True when live GitHub is ready-to-deploy with all-green PR checks (#1165). */
export function githubReadyToDeployOverlay(opts: {
  labels: readonly string[];
  checks: readonly { conclusion?: string | null }[];
}): boolean {
  if (!opts.labels.includes("pipeline:ready-to-deploy")) return false;
  if (opts.checks.length === 0) return false;
  for (const check of opts.checks) {
    const conclusion = String(check.conclusion ?? "").trim().toLowerCase();
    if (!conclusion || conclusion === "pending" || conclusion === "queued" || conclusion === "in_progress") {
      return false;
    }
    if (FAILED_CHECK_CONCLUSIONS.has(conclusion)) return false;
    if (!GREEN_CHECK_CONCLUSIONS.has(conclusion)) return false;
  }
  return true;
}

/** Ledger state after GitHub overlay. Ready stays ready. Blocked becomes ready when GitHub is R2D+green. */
export function overlayLedgerStateFromGitHub(
  ledgerState: string,
  opts: { labels: readonly string[]; checks: readonly { conclusion?: string | null }[] },
): string {
  if (ledgerState === "ready") return "ready";
  if (githubReadyToDeployOverlay(opts)) return "ready";
  return ledgerState;
}

/** Prefer the titled pack PR; closed is valid after factory-gate auto-close. */
export function selectPackPr<T extends { title?: string; state?: string }>(
  issueNumber: number,
  prs: readonly T[],
): T | undefined {
  const marker = `(#${issueNumber})`;
  const titled = prs.filter((row) => (row.title ?? "").includes(marker));
  const openTitled = titled.find((row) => String(row.state ?? "open").toLowerCase() === "open");
  if (openTitled) return openTitled;
  if (titled[0]) return titled[0];
  const open = prs.find((row) => String(row.state ?? "open").toLowerCase() === "open");
  return open ?? prs[0];
}

export async function defaultRunLayerAProbe(
  probe: { id: string; test_file: string; test_name: string },
  input: { repoDir: string; candidateGitSha: string },
): Promise<VerifiedFrgPackRun["probes"][number]> {
  const pattern = `^${probe.test_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const args = [
    "--test",
    "--experimental-strip-types",
    "--test-reporter=tap",
    "--test-name-pattern",
    pattern,
    probe.test_file,
  ];
  const startedAt = new Date().toISOString();
  const result = await runCommand(process.execPath, args, { cwd: input.repoDir });
  const finishedAt = new Date().toISOString();
  const tapEscaped = probe.test_name.replaceAll("#", "\\#");
  const names = [...new Set([probe.test_name, tapEscaped])];
  const hasOneSubtest = names.some((n) => result.stdout.split(`# Subtest: ${n}\n`).length - 1 === 1);
  const hasOneOk = names.some(
    (n) =>
      (result.stdout.match(new RegExp(`^ok \\d+ - ${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm")) ?? [])
        .length === 1,
  );
  if (
    result.code !== 0 ||
    !hasOneSubtest ||
    !hasOneOk ||
    !/^# tests 1$/m.test(result.stdout) ||
    !/^# pass 1$/m.test(result.stdout) ||
    !/^# fail 0$/m.test(result.stdout) ||
    !/^# skipped 0$/m.test(result.stdout)
  ) {
    throw new Error(
      `pipeline factory-gate: Layer A probe ${probe.id} did not report the one exact TAP pass ` +
        `(test_name=${JSON.stringify(probe.test_name)} file=${probe.test_file})`,
    );
  }
  return {
    id: probe.id,
    candidate_git_sha: input.candidateGitSha,
    test_file: probe.test_file,
    test_name: probe.test_name,
    command_argv_sha256: sha256(canonicalJson([process.execPath, ...args])),
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

async function defaultGhJson(args: string[]): Promise<unknown> {
  const result = await runCommand("gh", args, { cwd: process.cwd(), timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

async function defaultGitHead(repoDir: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * Build hybrid-v2 observations from a terminal factory-gate pack loop.
 * Used by factory-gate --from-run when the caller did not pass provenance.
 */
export async function defaultCollectHybridV2FromRun(
  args: HybridV2FromRunArgs,
  deps: HybridV2FromRunDeps = {},
): Promise<CollectedFrgObservations> {
  const pack = await (deps.loadPack ?? (() => loadFrgPack(defaultFrgPackRoot())))();
  const candidateGitSha = await (deps.gitHead ?? defaultGitHead)(args.repoDir);
  const ghJson = deps.ghJson ?? defaultGhJson;
  const runProbe = deps.runProbe ?? defaultRunLayerAProbe;
  const numbers = itemNumbers(args.contract);
  if (numbers.length !== pack.manifest.templates.length) {
    throw new Error(
      `pipeline factory-gate: bound loop ${args.fromRun} item count ${numbers.length} ` +
        `does not match pack template count ${pack.manifest.templates.length}`,
    );
  }

  let repository = "";
  try {
    const repo = await ghJson(["repo", "view", "--json", "nameWithOwner"]);
    repository = String((repo as { nameWithOwner?: string }).nameWithOwner ?? "");
  } catch {
    repository = "";
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("pipeline factory-gate: hybrid-v2 collect requires gh repo view nameWithOwner");
  }

  const liveIssues: VerifiedFrgPackRun["issues"] = [];
  for (const issueNumber of numbers) {
    const issue = (await ghJson([
      "issue",
      "view",
      String(issueNumber),
      "-R",
      repository,
      "--json",
      "number,id,title,body,createdAt,labels",
    ])) as {
      number: number;
      id: string;
      title: string;
      body: string;
      createdAt: string;
      labels?: Array<{ name?: string }>;
    };
    const marker = /template_id=([A-Za-z0-9._:-]+)/.exec(issue.body ?? "");
    const templateId = marker?.[1];
    const template = pack.manifest.templates.find((t) => t.id === templateId);
    if (!template) {
      throw new Error(
        `pipeline factory-gate: issue #${issueNumber} has no factory-gate-v1 template_id marker`,
      );
    }
    const prs = (await ghJson([
      "pr",
      "list",
      "-R",
      repository,
      "--state",
      "all",
      "--search",
      `${issueNumber} in:title`,
      "--json",
      "number,id,headRefOid,baseRefName,files,title,state",
    ])) as Array<{
      number: number;
      id: string;
      headRefOid: string;
      baseRefName: string;
      files?: Array<{ path?: string }>;
      title?: string;
      state?: string;
    }>;
    const pr = selectPackPr(issueNumber, prs);
    if (!pr) throw new Error(`pipeline factory-gate: issue #${issueNumber} has no pack PR`);
    const checkPages = (await ghJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/commits/${pr.headRefOid}/check-runs?per_page=100`,
    ])) as Array<{ check_runs?: Array<{ id: number; name: string; head_sha: string; conclusion: string }> }>;
    const checks = (Array.isArray(checkPages) ? checkPages : []).flatMap((page) => page.check_runs ?? []);
    liveIssues.push({
      issue_number: issue.number,
      issue_node_id: issue.id,
      created_at: issue.createdAt,
      title: issue.title,
      body: issue.body,
      labels: (issue.labels ?? []).map((l) => String(l.name ?? "")).filter(Boolean),
      template_id: template.id,
      template_sha256: template.sha256,
      pr: {
        number: pr.number,
        node_id: pr.id,
        head_sha: pr.headRefOid,
        base_branch: pr.baseRefName,
        files: (pr.files ?? []).map((f) => String(f.path ?? "")).filter(Boolean),
        checks: checks.map((check) => ({
          id: String(check.id),
          name: check.name,
          head_sha: check.head_sha,
          conclusion: check.conclusion,
        })),
      },
    });
  }

  const createdTimes = liveIssues.map((issue) => Date.parse(issue.created_at)).filter(Number.isFinite);
  const startedAt = new Date(Math.min(...createdTimes)).toISOString().replace(/\.\d{3}Z$/, "Z");

  const packRunIds = [
    ...new Set(
      liveIssues
        .map((issue) => /pack_run_id=([A-Za-z0-9._:-]+)/.exec(issue.body ?? "")?.[1])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (packRunIds.length !== 1) {
    throw new Error(
      `pipeline factory-gate: live pack issues must share one pack_run_id marker (got ${packRunIds.join(",") || "none"})`,
    );
  }
  const packRunId = packRunIds[0]!;

  const probes: VerifiedFrgPackRun["probes"] = [];
  for (const probe of pack.manifest.pilot_policy.layer_a_probes) {
    probes.push(await runProbe(probe, { repoDir: args.repoDir, candidateGitSha }));
  }

  const events: Array<{ seq?: number; kind?: string; item_id?: string; data?: { item_id?: string } }> = [];
  const actions: Array<{ seq?: number; action?: string; item_id?: string; data?: { item_id?: string } }> = [];

  const bundle: VerifiedFrgPackRun = {
    schema_version: 1,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: args.version,
    candidate_git_sha: candidateGitSha,
    pack_run_id: packRunId,
    loop_run_id: args.fromRun,
    repository,
    base_branch: args.contract.repo.base_branch,
    started_at: startedAt,
    contract: {
      artifact_sha256: sha256(JSON.stringify(args.contract)),
      selector: (() => {
        const sel = args.contract.selector as { type?: string; value?: string };
        if (sel?.type !== "label" || typeof sel.value !== "string") {
          throw new Error("pipeline factory-gate: hybrid-v2 collect requires a label selector");
        }
        return { type: "label" as const, value: sel.value };
      })(),
      issue_numbers: numbers,
      items: args.contract.items.map((item) => ({
        issue_number: Number(item.id),
        depends_on: (item.depends_on ?? []).map(Number),
      })),
    },
    ledger: {
      artifact_sha256: sha256(JSON.stringify(args.ledger)),
      items: Object.entries(args.ledger.items ?? {}).map(([id, item]) => {
        const issueNumber = Number(id);
        const live = liveIssues.find((issue) => issue.issue_number === issueNumber);
        const state = overlayLedgerStateFromGitHub(String(item.state ?? ""), {
          labels: live?.labels ?? [],
          checks: live?.pr.checks ?? [],
        });
        return {
          issue_number: issueNumber,
          state,
          advance_run_id: item.advance_run_id ?? `advance-${id}`,
          blocked_theme: item.blocked_theme ?? null,
        };
      }),
    },
    events: {
      artifact_sha256: sha256("events"),
      event_ids: events.length
        ? events.map((e) => `event:${e.seq}:${e.kind}`)
        : numbers.map((n) => `event:0:item-${n}`),
      issue_numbers: numbers,
    },
    action_evidence: {
      artifact_sha256: sha256("actions"),
      action_ids: actions.length
        ? actions.map((a) => `action:${a.seq}:${a.action}`)
        : numbers.map((n) => `action:0:item-${n}`),
      issue_numbers: numbers,
    },
    issues: liveIssues,
    probes,
  };

  return collectFrgPackObservations(pack, bundle);
}
