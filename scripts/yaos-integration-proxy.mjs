import knowledgeWorker, { YjsClientDO } from "../src/index.js";

export { YjsClientDO };

const YAOS_PROXY_PREFIX = "/__integration/yaos/";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(YAOS_PROXY_PREFIX)) {
      if (env.INTEGRATION_TEST !== "true") return new Response("Not found", { status: 404 });

      const upstream = new URL(request.url);
      upstream.protocol = "https:";
      upstream.hostname = "yaos.internal";
      upstream.pathname = url.pathname.slice("/__integration/yaos".length);
      return env.YAOS.fetch(new Request(upstream, request));
    }

    return knowledgeWorker.fetch(request, env, ctx);
  },
  scheduled(event, env, ctx) {
    return knowledgeWorker.scheduled(event, env, ctx);
  },
};
