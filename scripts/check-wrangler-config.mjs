import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

assert.equal(config.name, "akatuki-knowledge");
assert.equal(config.main, "src/index.js");
assert.equal(config.compatibility_date, "2026-10-17");
assert.deepEqual(config.triggers?.crons, ["0 * * * *"]);
assert.equal(config.d1_databases?.[0]?.binding, "DB");
assert.equal(config.d1_databases?.[0]?.database_id, "e8c57dbe-0175-43d8-9c16-0501e0c1d5a6");
assert.equal(config.durable_objects?.bindings?.find((x) => x.name === "YJS_CLIENT")?.class_name, "YjsClientDO");
assert.equal(config.services?.find((x) => x.binding === "YAOS")?.service, "yaos");
assert.equal(config.services?.find((x) => x.binding === "YAOS")?.environment, "production");
assert.equal(config.vars?.GEMINI_MODEL, "gemini-3.5-flash-lite");
assert.equal(config.vars?.GEMINI_LIGHT_MODEL, "gemini-3.1-flash-lite");
assert.equal(config.vars?.ORGANIZE_PER_RUN, "2");
assert.ok(!("migrations" in config), "Do not invent Durable Object migration declarations before recovering v1-v5");
console.log("Recovered Wrangler config draft checks passed; deploy remains blocked on DO migration recovery.");
