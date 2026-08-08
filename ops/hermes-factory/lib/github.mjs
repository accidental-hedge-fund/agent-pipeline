import { requireSuccess } from "./runtime.mjs";

const OPEN_PRS_QUERY =
  "query($owner:String!,$repo:String!,$after:String){repository(owner:$owner,name:$repo){" +
  "pullRequests(first:100,states:OPEN,after:$after){pageInfo{hasNextPage endCursor}nodes{" +
  "number state isDraft headRefName headRefOid baseRefName isCrossRepository " +
  "closingIssuesReferences(first:50){nodes{number repository{name owner{login}}}}}}}}";

function parseJsonResult(result, operation) {
  requireSuccess(result, operation, []);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

function sameRepository(ref, repository) {
  const owner = ref?.repository?.owner?.login;
  const name = ref?.repository?.name;
  return typeof owner === "string" && typeof name === "string" && `${owner}/${name}`.toLowerCase() === repository.toLowerCase();
}

export async function listOpenPullRequests(exec, ghCommand, repository) {
  const [owner, repo] = repository.split("/");
  const nodes = [];
  let after = null;
  for (let page = 0; page < 50; page += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${OPEN_PRS_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
    ];
    if (after) args.push("-F", `after=${after}`);
    const envelope = parseJsonResult(await exec(ghCommand, args), "gh open-PR query");
    if (Array.isArray(envelope.errors) && envelope.errors.length) {
      throw new Error("gh open-PR query returned GraphQL errors");
    }
    const pageData = envelope?.data?.repository?.pullRequests;
    if (!pageData || !Array.isArray(pageData.nodes) || !pageData.pageInfo) {
      throw new Error("gh open-PR query omitted repository.pullRequests");
    }
    nodes.push(...pageData.nodes);
    if (!pageData.pageInfo.hasNextPage) return nodes;
    if (!pageData.pageInfo.endCursor) throw new Error("gh open-PR query has no next-page cursor");
    after = pageData.pageInfo.endCursor;
  }
  throw new Error("gh open-PR query exceeded the 5000-PR safety bound");
}

export function resolveLinkedPullRequest(prs, issue, repository, baseBranch) {
  const branchPrefix = `pipeline/${issue}-`;
  const matches = prs.filter((pr) => {
    if (pr.isCrossRepository || pr.state !== "OPEN" || pr.baseRefName !== baseBranch) return false;
    const refs = pr.closingIssuesReferences?.nodes ?? [];
    const closesIssue = refs.some((ref) => ref.number === issue && sameRepository(ref, repository));
    const pipelineBranch = typeof pr.headRefName === "string" && pr.headRefName.startsWith(branchPrefix);
    return closesIssue && pipelineBranch;
  });
  if (matches.length !== 1) {
    throw new Error(
      `issue #${issue} must resolve to exactly one open same-repository Pipeline PR on ${baseBranch} (found ${matches.length})`,
    );
  }
  const pr = matches[0];
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !/^[a-f0-9]{40,64}$/i.test(pr.headRefOid ?? "")) {
    throw new Error(`issue #${issue} resolved to a PR with an invalid number or head identity`);
  }
  return {
    number: pr.number,
    head_oid: pr.headRefOid,
    head_ref: pr.headRefName,
    base_ref: pr.baseRefName,
    is_draft: Boolean(pr.isDraft),
  };
}

export async function observeIssue(exec, ghCommand, repository, issue) {
  const args = [
    "issue",
    "view",
    String(issue),
    "--repo",
    repository,
    "--json",
    "number,state,labels,milestone,comments",
  ];
  const data = parseJsonResult(await exec(ghCommand, args), "gh issue view");
  const labels = Array.isArray(data.labels) ? data.labels.map((label) => label?.name).filter(Boolean) : [];
  const comments = Array.isArray(data.comments)
    ? data.comments.map((comment) => ({
        author: comment?.author?.login ?? null,
        body: comment?.body ?? "",
        created_at: comment?.createdAt ?? null,
      }))
    : [];
  return { number: data.number, state: data.state, labels, milestone: data.milestone?.title ?? null, comments };
}

function lastReviewedSha(body) {
  const pattern = /^<!-- reviewed-sha: ([a-f0-9]{40}) -->$/gim;
  let match;
  let sha = null;
  while ((match = pattern.exec(body)) !== null) sha = match[1].toLowerCase();
  return sha;
}

export function validateIndependentReviewProof(comments, { actor, headOid }) {
  if (!Array.isArray(comments) || !/^[A-Za-z0-9-]+$/.test(actor ?? "") || !/^[a-f0-9]{40}$/i.test(headOid ?? "")) {
    throw new Error("independent review proof inputs are invalid");
  }
  const trusted = comments.filter((comment) => comment?.author === actor && typeof comment?.body === "string");
  const plan = [...trusted].reverse().find((comment) => comment.body.startsWith("## Plan Review"));
  if (!plan || !/^\*\*Reviewer\*\*: codex$/m.test(plan.body) || /Same-harness self-review/i.test(plan.body)) {
    throw new Error("the issue has no trusted independent Codex plan review");
  }
  const reviews = trusted.filter((comment) =>
    comment.body.startsWith("## Review 1") ||
    comment.body.startsWith("## Review 2") ||
    comment.body.startsWith("## Pre-merge Delta Review"),
  );
  const current = [...reviews].reverse().find((comment) => lastReviewedSha(comment.body) === headOid.toLowerCase());
  if (
    !current ||
    !/^\*\*Reviewer\*\*: (?:codex|pre-merge delta review by codex)$/m.test(current.body) ||
    /Same-harness self-review|self-review of/i.test(current.body)
  ) {
    throw new Error("the candidate head has no trusted independent Codex review");
  }
  return { actor, reviewed_head: headOid.toLowerCase(), reviewer: "codex" };
}

export async function observePullRequest(exec, ghCommand, repository, prNumber) {
  const args = [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repository,
    "--json",
    "number,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,mergeCommit,title,body,changedFiles",
  ];
  const data = parseJsonResult(await exec(ghCommand, args), "gh pr view");
  if (!Number.isSafeInteger(data.changedFiles) || data.changedFiles < 0) {
    throw new Error("gh pr view returned an invalid changedFiles count");
  }
  const filePages = parseJsonResult(
    await exec(ghCommand, [
      "api",
      `repos/${repository}/pulls/${prNumber}/files?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
    "gh PR-files query",
  );
  if (!Array.isArray(filePages) || filePages.some((page) => !Array.isArray(page))) {
    throw new Error("gh PR-files query did not return complete pages");
  }
  const files = filePages.flatMap((page) => page.map((file) => file?.filename));
  if (files.some((path) => typeof path !== "string" || path.length === 0)) {
    throw new Error("gh PR-files query returned an invalid file path");
  }
  if (files.length !== data.changedFiles) {
    throw new Error(
      `gh PR-files query returned ${files.length} of ${data.changedFiles} changed files`,
    );
  }
  if (new Set(files).size !== files.length) {
    throw new Error("gh PR-files query returned duplicate file paths");
  }
  return {
    number: data.number,
    state: data.state,
    is_draft: Boolean(data.isDraft),
    head_ref: data.headRefName,
    head_oid: data.headRefOid,
    base_ref: data.baseRefName,
    mergeable: data.mergeable,
    merge_state: data.mergeStateStatus,
    merge_oid: data.mergeCommit?.oid ?? null,
    title: data.title ?? "",
    body: data.body ?? "",
    changed_files: data.changedFiles,
    files,
  };
}

function classifyChecks(checks) {
  if (!Array.isArray(checks)) throw new Error("GitHub checks response must be an array");
  if (checks.length === 0) return "absent";
  const terminal = checks.filter((check) => ["fail", "cancel"].includes(String(check?.bucket ?? "").toLowerCase()));
  if (terminal.length) {
    throw new Error(`required checks failed: ${terminal.map((check) => check?.name ?? "unknown").join(", ")}`);
  }
  return checks.every((check) => ["pass", "skipping"].includes(String(check?.bucket ?? "").toLowerCase()))
    ? "green"
    : "pending";
}

function noChecksReported(result) {
  const detail = `${result.stdout ?? ""} ${result.stderr ?? ""}`.toLowerCase();
  return detail.includes("no required checks reported") || detail.includes("no checks reported");
}

async function observeChecks(exec, ghCommand, repository, prNumber) {
  const requiredArgs = [
    "pr",
    "checks",
    String(prNumber),
    "--required",
    "--json",
    "name,bucket",
    "--repo",
    repository,
  ];
  const required = await exec(ghCommand, requiredArgs);
  if (required.code === 0) {
    const checks = parseJsonResult(required, "gh required checks");
    if (!Array.isArray(checks)) throw new Error("GitHub checks response must be an array");
    const state = classifyChecks(checks);
    if (state !== "absent") return state;
  } else if (!noChecksReported(required)) {
    throw new Error("GitHub could not report required checks");
  }
  const allArgs = [
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "name,bucket",
    "--repo",
    repository,
  ];
  const all = await exec(ghCommand, allArgs);
  if (all.code !== 0 && noChecksReported(all)) return "absent";
  const checks = parseJsonResult(all, "gh checks");
  if (!Array.isArray(checks)) throw new Error("GitHub checks response must be an array");
  return classifyChecks(checks);
}

export async function requireGreenChecks(
  exec,
  ghCommand,
  repository,
  prNumber,
  {
    attempts = null,
    timeoutMs = 900_000,
    retryDelayMs = 5_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onWait = async () => {},
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) throw new Error("check timeout is invalid");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) {
    throw new Error("check observation retry delay must be from 0 through 60000 milliseconds");
  }
  const boundedAttempts = attempts ?? Math.max(1, Math.floor(timeoutMs / Math.max(1, retryDelayMs)) + 1);
  if (!Number.isSafeInteger(boundedAttempts) || boundedAttempts < 1 || boundedAttempts > 1000) {
    throw new Error("check observation attempts must be an integer from 1 through 1000");
  }
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    const state = await observeChecks(exec, ghCommand, repository, prNumber);
    if (state === "green") return;
    if (attempt < boundedAttempts) {
      await onWait({ state, attempt });
      await sleep(retryDelayMs);
    }
  }
  throw new Error(`GitHub checks did not become green after ${boundedAttempts} bounded observations`);
}

export async function resolveReleasePullRequest(exec, ghCommand, repository, baseBranch, version) {
  const prs = await listOpenPullRequests(exec, ghCommand, repository);
  const branch = `release/v${version}`;
  const matches = prs.filter(
    (pr) => !pr.isCrossRepository && pr.state === "OPEN" && pr.baseRefName === baseBranch && pr.headRefName === branch,
  );
  if (matches.length !== 1) {
    throw new Error(`release v${version} must resolve to exactly one open ${branch} PR (found ${matches.length})`);
  }
  return observePullRequest(exec, ghCommand, repository, matches[0].number);
}

export function validateReleasePullRequest(pr, { version, baseBranch, frgRunId }) {
  if (pr.state !== "OPEN" || pr.is_draft) throw new Error("the release PR must be open and not a draft");
  if (pr.base_ref !== baseBranch || pr.head_ref !== `release/v${version}`) {
    throw new Error("the release PR base or head branch does not match the granted release");
  }
  if (!/^[a-f0-9]{40,64}$/i.test(pr.head_oid ?? "")) throw new Error("the release PR head identity is invalid");
  if (!pr.title.startsWith(`release: ${version} —`)) throw new Error("the release PR title version does not match");
  if (!pr.body.includes(`## Release: v${version} —`) || !pr.body.includes(`FRG run_id:** \`${frgRunId}\``)) {
    throw new Error("the release PR body does not bind the release and FRG identities");
  }
  if (pr.body.includes("### Open soak-defect override")) {
    throw new Error("the scoped factory refuses release PRs with an open soak-defect override");
  }
  const versionPath = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const managed = [
    /^package\.json$/,
    /^core\/package\.json$/,
    /^ROADMAP\.md$/,
    /^plugin\//,
    new RegExp(`^\\.agent-pipeline/frg/${versionPath}/`),
    /^\.agent-pipeline\/frg\/trend-ledger\.jsonl$/,
  ];
  const unexpected = pr.files.filter((path) => !managed.some((pattern) => pattern.test(path)));
  if (unexpected.length) throw new Error(`the release PR changes unmanaged path(s): ${unexpected.join(", ")}`);
  for (const required of ["package.json", "core/package.json", ".agent-pipeline/frg/"]) {
    if (required.endsWith("/")) {
      if (!pr.files.some((path) => path.startsWith(required + version))) {
        throw new Error(`the release PR is missing ${required}${version} evidence`);
      }
    } else if (!pr.files.includes(required)) {
      throw new Error(`the release PR is missing ${required}`);
    }
  }
}

export async function observePublishedRelease(exec, ghCommand, repository, tag) {
  const args = [
    "release",
    "view",
    tag,
    "--repo",
    repository,
    "--json",
    "tagName,isDraft,isPrerelease,publishedAt,url",
  ];
  const result = await exec(ghCommand, args);
  if (result.code !== 0) return null;
  const data = parseJsonResult(result, "gh release view");
  return {
    tag: data.tagName,
    draft: Boolean(data.isDraft),
    prerelease: Boolean(data.isPrerelease),
    published_at: data.publishedAt ?? null,
    url: data.url ?? null,
  };
}
