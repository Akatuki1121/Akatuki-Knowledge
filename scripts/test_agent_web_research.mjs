import assert from "node:assert/strict";
import {
  AGENT_WEB_RESEARCH_LIMITS,
  parseGroundedWebResearch,
  validateSavedWebResearchResult,
} from "../src/agent-web-research.mjs";

const checkedAt = "2026-10-22T12:00:00.000Z";
const interaction = {
  steps: [
    { type: "google_search_call", arguments: { queries: ["official release date"] } },
    { type: "url_context_result", result: { status: "success", url: "https://example.org/release" } },
    {
      type: "model_output",
      content: [{
        type: "text",
        text: "The official notice lists the release date as May 3, 2026.",
        annotations: [{
          type: "url_citation",
          url: "https://example.org/release",
          title: "Official release notice",
          start_index: 0,
          end_index: "The official notice lists the release date as May 3, 2026.".length,
        }],
      }],
    },
  ],
};

const result = parseGroundedWebResearch(interaction, checkedAt);
assert.equal(result.report, "The official notice lists the release date as May 3, 2026.");
assert.deepEqual(result.sources, [{
  url: "https://example.org/release",
  title: "Official release notice",
  evidence: result.report,
  checkedAt,
}]);

assert.throws(
  () => parseGroundedWebResearch({ steps: interaction.steps.slice(1) }, checkedAt),
  (error) => error.message === "web_research_unverified",
);
assert.throws(
  () => parseGroundedWebResearch({ steps: interaction.steps.slice(0, 2) }, checkedAt),
  (error) => error.message === "web_research_invalid_response",
);

const withoutPageRead = interaction.steps.filter((step) => step.type !== "url_context_result");
assert.throws(
  () => parseGroundedWebResearch({ steps: withoutPageRead }, checkedAt),
  (error) => error.message === "web_research_unverified",
);
const unsafePage = structuredClone(interaction);
unsafePage.steps[1].result.status = "unsafe";
assert.throws(
  () => parseGroundedWebResearch(unsafePage, checkedAt),
  (error) => error.message === "web_research_unverified",
);

for (const url of ["http://example.org", "https://user:pass@example.org/page", "javascript:alert(1)"]) {
  const unsafe = structuredClone(interaction);
  unsafe.steps[2].content[0].annotations[0].url = url;
  assert.throws(
    () => parseGroundedWebResearch(unsafe, checkedAt),
    (error) => error.message === "web_research_sources_missing",
  );
}

const tooManySources = {
  report: "Summary",
  sources: Array.from({ length: AGENT_WEB_RESEARCH_LIMITS.maxSourcesPerCall + 1 }, (_, index) => ({
    url: `https://example.org/${index}`,
    title: `Source ${index}`,
    evidence: "Claim",
    checkedAt,
  })),
};
assert.throws(() => validateSavedWebResearchResult(tooManySources), /invalid_input/);

const longEvidence = {
  report: "Summary",
  sources: [{
    url: "https://example.org",
    title: "Source",
    evidence: "x".repeat(AGENT_WEB_RESEARCH_LIMITS.maxEvidenceChars + 1),
    checkedAt,
  }],
};
assert.throws(() => validateSavedWebResearchResult(longEvidence), /invalid_input/);

const tooManyQueriesInteraction = structuredClone(interaction);
tooManyQueriesInteraction.steps[0].arguments.queries = [
  "query 1", "query 2", "query 3", "query 4", "query 5"
];
assert.throws(
  () => parseGroundedWebResearch(tooManyQueriesInteraction, checkedAt),
  (error) => error.message === "web_research_query_budget_exceeded",
);

console.log("Agent web research checks passed: grounded search, page retrieval, source attribution, URL safety, and bounded checkpoints.");
