import { executeGitHubWritePlan, hashGitHubWritePlan } from "./agent-github-tools.mjs";
import { validateImprovementPlan } from "./agent-improvement-policy.mjs";

async function githubRequest(path, { token, fetchImpl, method = "GET", body } = {}) {
  const response = await fetchImpl("https://api.github.com" + path, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Akatuki-Knowledge",
      authorization: "Bearer " + token
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) throw new Error(response.status === 403 ? "github_access_denied" : "github_request_failed");
  return response.json();
}

export async function executeApprovedImprovementPlan({ plan, expectedPlanHash, token, fetchImpl = fetch }) {
  const policy = validateImprovementPlan(plan);
  if (!policy.ok) return { ok: false, reason: policy.reason };
  if (typeof token !== "string" || !token) return { ok: false, reason: "github_token_missing" };
  const actualPlanHash = await hashGitHubWritePlan(plan);
  if (actualPlanHash !== expectedPlanHash) return { ok: false, reason: "approved_plan_hash_mismatch" };

  const execution = await executeGitHubWritePlan(plan, { token, fetchImpl });
  const pullRequest = [...execution.results].reverse().find((item) => item.operation === "create_pull_request");
  if (!pullRequest?.number || !pullRequest.url) {
    return { ok: false, reason: "pull_request_result_missing" };
  }

  try {
    const details = await githubRequest(
      "/repos/" + plan.repository + "/pulls/" + pullRequest.number,
      { token, fetchImpl }
    );
    if (details.auto_merge) return { ok: true, pullRequestUrl: pullRequest.url, autoMergeEnabled: true };
    if (typeof details.node_id !== "string" || !details.node_id) {
      return { ok: true, pullRequestUrl: pullRequest.url, autoMergeEnabled: false, reason: "pull_request_node_id_missing" };
    }
    const result = await githubRequest("/graphql", {
      token,
      fetchImpl,
      method: "POST",
      body: {
        query: "mutation EnableAutoMerge($input: EnablePullRequestAutoMergeInput!) { enablePullRequestAutoMerge(input: $input) { pullRequest { number } } }",
        variables: { input: { pullRequestId: details.node_id, mergeMethod: "SQUASH" } }
      }
    });
    if (Array.isArray(result.errors) && result.errors.length) {
      const alreadyEnabled = result.errors.some((error) => /already.{0,40}auto.?merge|auto.?merge.{0,40}already/iu.test(String(error?.message || "")));
      return alreadyEnabled
        ? { ok: true, pullRequestUrl: pullRequest.url, autoMergeEnabled: true }
        : { ok: true, pullRequestUrl: pullRequest.url, autoMergeEnabled: false, reason: "auto_merge_not_enabled" };
    }
    return { ok: true, pullRequestUrl: pullRequest.url, autoMergeEnabled: true };
  } catch {
    return { ok: true, pullRequestUrl: pullRequest.url, autoMergeEnabled: false, reason: "auto_merge_not_enabled" };
  }
}
