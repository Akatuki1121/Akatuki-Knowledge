import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

for (const required of [
  'name = "akatuki-knowledge"',
  'main = "src/index.js"',
  'compatibility_date = "2026-10-17"',
  'crons = ["0 * * * *", "*/5 * * * *"]',
  'binding = "DB"',
  'database_id = "e8c57dbe-0175-43d8-9c16-0501e0c1d5a6"',
  'name = "YJS_CLIENT"',
  'class_name = "YjsClientDO"',
  'binding = "YAOS"',
  'service = "yaos"',
  'environment = "production"',
  'tag = "v1"',
  'tag = "v2"',
  'tag = "v3"',
  'tag = "v4"',
  'tag = "v5"'
]) assert.ok(config.includes(required), "Missing Wrangler config contract: " + required);

assert.equal((config.match(/\[\[migrations\]\]/g) || []).length, 5, "Preserve the recovered v1-v5 Durable Object migration history");
assert.ok(!/migrations_dir\s*=/.test(config), "Do not point Wrangler at the unrecovered D1 migration chain");
console.log("Recovered Wrangler TOML and Durable Object migration history checks passed.");
