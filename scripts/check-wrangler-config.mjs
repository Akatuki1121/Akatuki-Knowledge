import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

const deployWorkflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
assert.ok(deployWorkflow.includes("Gate deployment on pending D1 migrations"), "Production deploy must be gated while candidate D1 migrations are pending");
assert.ok(deployWorkflow.includes("find migrations/pending -maxdepth 1 -type f -name '*.sql'"), "Deploy gate must detect pending SQL migrations");
assert.ok(deployWorkflow.includes("if: steps.migration_gate.outputs.allowed == 'true'"), "Credential validation and deploy must require the migration gate");
assert.ok(deployWorkflow.indexOf("Gate deployment on pending D1 migrations") < deployWorkflow.indexOf("Deploy production Worker"), "Migration gate must precede the deploy step");

for (const required of [
  'name = "akatuki-knowledge"',
  'main = "src/index.js"',
  'compatibility_date = "2026-10-17"',
  'crons = ["0 * * * *", "*/15 * * * *", "0 */12 * * *"]',
  'binding = "DB"',
  'database_id = "e8c57dbe-0175-43d8-9c16-0501e0c1d5a6"',
  'name = "YJS_CLIENT"',
  'class_name = "YjsClientDO"',
  'binding = "YAOS"',
  'binding = "AI"',
  'service = "yaos"',
  'environment = "production"',
  'name = "akatuki-knowledge-agent-tasks"',
  'binding = "AGENT_TASK_WORKFLOW"',
  'class_name = "AgentTaskWorkflow"',
  'tag = "v1"',
  'tag = "v2"',
  'tag = "v3"',
  'tag = "v4"',
  'tag = "v5"'
]) assert.ok(config.includes(required), "Missing Wrangler config contract: " + required);

assert.equal((config.match(/\[\[migrations\]\]/g) || []).length, 5, "Preserve the recovered v1-v5 Durable Object migration history");
assert.equal((config.match(/\[\[workflows\]\]/g) || []).length, 1, "Define one agent task workflow binding");
assert.ok(!/migrations_dir\s*=/.test(config), "Do not point Wrangler at the unrecovered D1 migration chain");
console.log("Recovered Wrangler TOML, Workflow binding, and Durable Object migration history checks passed.");
