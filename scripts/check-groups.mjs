export const checks = [
  ["source-syntax", process.execPath, ["--check", "src/index.js"]],
  ["check-group-coverage", process.execPath, ["scripts/test-check-groups.mjs"]],
  ["sync-module-syntax", process.execPath, ["--check", "src/sync-outbox.mjs"]],
  ["ai-send-guard-syntax", process.execPath, ["--check", "src/ai-send-guard.mjs"]],
  ["node-tests", process.execPath, ["--test", "tests/credential-guard.test.js", "tests/ai-send-guard.test.js", "tests/organize-failure.test.js", "tests/log-sanitize.test.js", "tests/gemini-client.test.js", "tests/reply-text.test.js", "tests/note-search-text.test.js", "tests/bot-alerts.test.js"]],
  ["log-sanitize-syntax", process.execPath, ["--check", "src/log-sanitize.mjs"]],
  ["gemini-client-syntax", process.execPath, ["--check", "src/gemini-client.mjs"]],
  ["reply-text-syntax", process.execPath, ["--check", "src/reply-text.mjs"]],
  ["note-search-text-syntax", process.execPath, ["--check", "src/note-search-text.mjs"]],
  ["bot-alerts-syntax", process.execPath, ["--check", "src/bot-alerts.mjs"]],
  ["telegram-removal", process.execPath, ["scripts/check-telegram-removal.mjs"]],
  ["log-hygiene", process.execPath, ["scripts/check-log-hygiene.mjs"]],
  ["sync-contract", process.execPath, ["scripts/check-sync-contract.mjs"]],
  ["yaos-integration-classifier", process.execPath, ["scripts/test_classify_yaos_integration.mjs"]],
  ["sync-identity", process.execPath, ["scripts/test-sync-identity.mjs"]],
  ["sync-conflicts", process.execPath, ["scripts/test-sync-conflicts.mjs"]],
  ["sync-telegram-identity", process.execPath, ["scripts/test-sync-telegram-identity.mjs"]],
  ["sync-telegram-rename", process.execPath, ["scripts/test-sync-telegram-rename.mjs"]],
  ["sync-outbox", process.execPath, ["scripts/test-sync-outbox.mjs"]],
  ["safe-note-id-recovery", process.execPath, ["scripts/test-safe-note-id-recovery.mjs"]],
  ["sync-strip-frontmatter-ids", process.execPath, ["scripts/test-sync-strip-frontmatter-ids.mjs"]],
  ["background-task-policy-syntax", process.execPath, ["--check", "src/background-task-policy.mjs"]],
  ["background-task-policy", process.execPath, ["scripts/test-background-task-policy.mjs"]],
  ["agent-tool-loop", process.execPath, ["scripts/test_agent_tool_loop.mjs"]],
  ["agent-github-tools", process.execPath, ["scripts/test_agent_github_tools.mjs"]],
  ["agent-evaluation-set", process.execPath, ["scripts/test_agent_evaluation_set.mjs"]],
  ["agent-web-research", process.execPath, ["scripts/test_agent_web_research.mjs"]],
  ["agent-memory", process.execPath, ["scripts/test_agent_memory.mjs"]],
  ["agent-memory-jobs-migration", "python3", ["scripts/test_agent_memory_jobs_migration.py"]],
  ["background-task-store", process.execPath, ["scripts/check-background-task-store.mjs"]],
  ["background-task-workflow", process.execPath, ["scripts/check-background-task-workflow.mjs"]],
  ["agent-task-idempotency", process.execPath, ["scripts/test_agent_task_idempotency.mjs"]],
  ["agent-tasks-migration", "python3", ["scripts/test_agent_tasks_migration.py"]],
  ["agent-task-store-sql", "python3", ["scripts/test_agent_task_store_sql.py"]],
  ["agent-task-recovery", "python3", ["scripts/test_agent_task_recovery.py"]],
  ["agent-memory-migration", "python3", ["scripts/test_agent_memory_migration.py"]],
  ["agent-organization", process.execPath, ["scripts/check-agent-organization.mjs"]],
  ["wrangler-config", process.execPath, ["scripts/check-wrangler-config.mjs"]]
];

export function selectChecks(args = []) {
  return args.includes("--sync-only")
  ? checks.filter(([name]) => name.startsWith("sync-") || name === "safe-note-id-recovery" || name === "sync-contract" || name === "yaos-integration-classifier" || name === "sync-module-syntax")
  : args.includes("--agent-only")
    ? checks.filter(([name]) => name.startsWith("agent-") || name.startsWith("background-task-"))
    : args.includes("--core-only")
      ? checks.filter(([name]) => ["source-syntax", "check-group-coverage", "sync-module-syntax", "ai-send-guard-syntax", "node-tests", "log-sanitize-syntax", "gemini-client-syntax", "reply-text-syntax", "note-search-text-syntax", "bot-alerts-syntax", "telegram-removal", "background-task-policy-syntax", "log-hygiene", "wrangler-config"].includes(name))
      : checks;
}
