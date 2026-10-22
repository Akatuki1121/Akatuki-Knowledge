export const AGENT_WEB_RESEARCH_LIMITS = Object.freeze({
  maxCalls: 2,
  maxSourcesPerCall: 4,
  maxReturnedSources: 3,
  maxReportChars: 4000,
  maxEvidenceChars: 300,
});

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function validSourceUrl(value) {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function containsUnsafePageStatus(value, depth = 0) {
  if (depth > 6 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsUnsafePageStatus(item, depth + 1));
  return Object.entries(value).some(([key, item]) =>
    (key === "status" && item === "unsafe") || containsUnsafePageStatus(item, depth + 1));
}

export function validateSavedWebResearchResult(value) {
  if (!isRecord(value)
    || typeof value.report !== "string"
    || !value.report.trim()
    || value.report.length > AGENT_WEB_RESEARCH_LIMITS.maxReportChars
    || !Array.isArray(value.sources)
    || value.sources.length < 1
    || value.sources.length > AGENT_WEB_RESEARCH_LIMITS.maxSourcesPerCall) {
    throw new Error("invalid_input");
  }

  const sources = value.sources.map((source) => {
    if (!isRecord(source)
      || !validSourceUrl(source.url)
      || typeof source.title !== "string"
      || !source.title.trim()
      || source.title.length > 256
      || typeof source.evidence !== "string"
      || !source.evidence.trim()
      || source.evidence.length > AGENT_WEB_RESEARCH_LIMITS.maxEvidenceChars
      || typeof source.checkedAt !== "string"
      || !Number.isFinite(Date.parse(source.checkedAt))) {
      throw new Error("invalid_input");
    }
    return {
      url: source.url,
      title: source.title.trim(),
      evidence: source.evidence.trim(),
      checkedAt: source.checkedAt,
    };
  });

  return { report: value.report.trim(), sources };
}

export function parseGroundedWebResearch(interaction, checkedAt) {
  if (!isRecord(interaction) || !Array.isArray(interaction.steps)) {
    throw new Error("web_research_invalid_response");
  }

  const hasSearch = interaction.steps.some((step) => step?.type === "google_search_call");
  const hasPageRead = interaction.steps.some((step) => step?.type === "url_context_result");
  if (!hasSearch || !hasPageRead || interaction.steps.some(containsUnsafePageStatus)) {
    throw new Error("web_research_unverified");
  }

  const textParts = [];
  const sources = new Map();
  for (const step of interaction.steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const block of step.content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      textParts.push(block.text);
      if (!Array.isArray(block.annotations)) continue;
      for (const annotation of block.annotations) {
        if (annotation?.type !== "url_citation"
          || !validSourceUrl(annotation.url)
          || typeof annotation.title !== "string"
          || !annotation.title.trim()
          || !Number.isInteger(annotation.start_index)
          || !Number.isInteger(annotation.end_index)
          || annotation.start_index < 0
          || annotation.end_index <= annotation.start_index
          || annotation.end_index > block.text.length) {
          continue;
        }
        const evidence = block.text.slice(annotation.start_index, annotation.end_index).trim();
        if (!evidence) continue;
        if (!sources.has(annotation.url)) {
          sources.set(annotation.url, {
            url: annotation.url,
            title: annotation.title.trim(),
            evidence: evidence.slice(0, AGENT_WEB_RESEARCH_LIMITS.maxEvidenceChars),
            checkedAt,
          });
        }
      }
    }
  }

  const report = textParts.join("\n").trim();
  if (!report || report.length > AGENT_WEB_RESEARCH_LIMITS.maxReportChars) {
    throw new Error("web_research_invalid_response");
  }
  const result = {
    report,
    sources: [...sources.values()].slice(0, AGENT_WEB_RESEARCH_LIMITS.maxSourcesPerCall),
  };
  if (result.sources.length === 0) throw new Error("web_research_sources_missing");
  return validateSavedWebResearchResult(result);
}
