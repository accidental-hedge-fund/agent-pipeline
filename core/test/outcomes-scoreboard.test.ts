import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  aggregateOutcomeScoreboardSection,
  collectOutcomeScoreboardSection,
  emptyOutcomeScoreboardSection,
} from "../scripts/outcomes/scoreboard-section.ts";
import {
  emptyDeliveryChain,
  makeOutcomeShell,
  type ProductionOutcome,
} from "../scripts/outcomes/schema.ts";
import { upsertOutcome, type OutcomeStoreDeps } from "../scripts/outcomes/store.ts";
import { buildScoreboardReport, type ScoreboardDeps } from "../scripts/scoreboard.ts";
import { runsDir } from "../scripts/run-store.ts";

const SHA = "a".repeat(40);
const REPO = "/repo";

function delivery(id: string, deploy: "succeeded" | "not_observed" = "not_observed"): ProductionOutcome {
  return makeOutcomeShell({
    outcome_id: id,
    outcome_kind: "delivery",
    observation_state: "observed",
    adapter_id: "github",
    signal_ref: id,
    summary: id,
    signal_at: "2026-06-10T12:00:00Z",
    observed_at: "2026-06-10T12:00:00Z",
    delivery: emptyDeliveryChain({
      merge_status: "merged",
      merged_sha: SHA,
      deploy_status: deploy,
    }),
    attribution: [
      {
        target_type: "pr",
        target_id: "1",
        method: "adapter",
        authority: "observed",
        confidence: 1,
      },
    ],
  });
}

function reversion(id: string, authority: "observed" | "inferred"): ProductionOutcome {
  return makeOutcomeShell({
    outcome_id: id,
    outcome_kind: "reversion",
    observation_state: authority === "inferred" ? "observed" : "observed",
    adapter_id: "github",
    signal_ref: id,
    summary: id,
    signal_at: "2026-06-11T12:00:00Z",
    observed_at: "2026-06-11T12:00:00Z",
    delivery: null,
    attribution:
      authority === "observed"
        ? [
            {
              target_type: "pr",
              target_id: "2",
              method: "adapter",
              authority: "observed",
              confidence: 1,
            },
          ]
        : [
            {
              target_type: "run",
              target_id: "run-x",
              method: "heuristic",
              authority: "inferred",
              confidence: 0.2,
            },
          ],
  });
}

test("kind counts and no maintainability_score", () => {
  const section = aggregateOutcomeScoreboardSection([
    delivery("d1"),
    reversion("r1", "observed"),
    reversion("r2", "observed"),
  ]);
  assert.equal(section.by_kind.delivery, 1);
  assert.equal(section.by_kind.reversion, 2);
  assert.equal(section.total, 3);
  assert.equal("maintainability_score" in section, false);
});

test("observation_state counts appear", () => {
  const delayed = makeOutcomeShell({
    outcome_id: "del",
    outcome_kind: "delivery",
    observation_state: "delayed",
    adapter_id: "github",
    signal_ref: "del",
    summary: "pending",
    signal_at: "2026-06-10T12:00:00Z",
    delivery: emptyDeliveryChain({ deploy_status: "in_progress" }),
  });
  const section = aggregateOutcomeScoreboardSection([delivery("d1"), delayed]);
  assert.equal(section.by_observation_state.observed, 1);
  assert.equal(section.by_observation_state.delayed, 1);
});

test("inferred-only linkage is not observed failure", () => {
  const section = aggregateOutcomeScoreboardSection([
    reversion("r-obs", "observed"),
    reversion("r-inf", "inferred"),
  ]);
  assert.equal(section.observed_failure_outcomes, 1);
  assert.equal(section.inferred_failure_linkages, 1);
  assert.equal(section.with_inferred_only_attribution, 1);
});

test("delivery merge without deploy is not deploy success", () => {
  const section = aggregateOutcomeScoreboardSection([
    delivery("d1", "not_observed"),
    delivery("d2", "succeeded"),
  ]);
  assert.equal(section.delivery_merged_count, 2);
  assert.equal(section.delivery_deploy_succeeded_count, 1);
  assert.equal(section.delivery_deploy_not_observed_count, 1);
});

test("missing outcome store is empty not fatal", async () => {
  const deps: OutcomeStoreDeps = {
    readFile: async (p) => {
      const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    writeFile: async () => {},
    readdir: async (p) => {
      const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    mkdir: async () => {},
  };
  const section = await collectOutcomeScoreboardSection({ repoDir: REPO }, deps);
  assert.equal(section.total, 0);
  assert.ok(section.diagnostics.some((d) => d.code === "missing_outcome_store"));
});

test("scoreboard JSON exposes outcomes section with kind counts", async () => {
  const files = new Map<string, string>();
  const storeDeps: OutcomeStoreDeps = {
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, c) => {
      files.set(p, c);
    },
    readdir: async (p) => {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      const names = new Set<string>();
      let any = false;
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          any = true;
          names.add(k.slice(prefix.length).split(path.sep)[0]!);
        }
      }
      if (!any) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return [...names].filter(Boolean).map((name) => ({
        name,
        isDirectory: () => !name.endsWith(".json") && !name.endsWith(".jsonl") && !name.includes("."),
      }));
    },
    mkdir: async () => {},
  };

  await upsertOutcome(REPO, delivery("d1"), storeDeps);
  await upsertOutcome(REPO, reversion("r1", "observed"), storeDeps);
  await upsertOutcome(REPO, reversion("r2", "observed"), storeDeps);

  // Minimal empty run store for scoreboard scan
  const scoreDeps: ScoreboardDeps = {
    readFile: async (p) => {
      if (files.has(p)) return files.get(p)!;
      const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    readdir: async (p) => {
      if (p === runsDir(REPO)) {
        return [];
      }
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      const names = new Set<string>();
      let any = false;
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          any = true;
          names.add(k.slice(prefix.length).split(path.sep)[0]!);
        }
      }
      if (!any) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return [...names].filter(Boolean).map((name) => ({
        name,
        isDirectory: () => false,
      }));
    },
    log: () => {},
    writeFile: async () => {},
    rename: async () => {},
    unlink: async () => {},
  };

  const report = await buildScoreboardReport(
    {
      repoDir: REPO,
      since: "2026-06-01T00:00:00Z",
      until: "2026-06-30T00:00:00Z",
    },
    scoreDeps,
  );
  assert.ok(report.outcomes);
  assert.equal(report.outcomes.by_kind.reversion, 2);
  assert.equal(report.outcomes.by_kind.delivery, 1);
  assert.equal("maintainability_score" in report, false);
  assert.equal("maintainability_score" in (report.outcomes as object), false);
});

test("emptyOutcomeScoreboardSection zeros", () => {
  const s = emptyOutcomeScoreboardSection();
  assert.equal(s.total, 0);
  assert.equal(s.by_kind.delivery, 0);
});
