# Worker entrypoint recovery

`index.js` is the compiled JavaScript module recovered from Cloudflare's deployed Worker. It intentionally remains a single file because the original source map and modular TypeScript source files were not available in the repository or the current deployment metadata.

The module includes a `cloudflare:workers` import and exports `YjsClientDO` plus the default Worker handler. Run `npm run check` to perform a JavaScript syntax check with Node.js. This is not a substitute for `wrangler dev` or an integration test in the Workers runtime.

Do not split this bundle into guessed modules or deploy it until the exact Durable Object migration declarations and D1 migration history have been recovered.
