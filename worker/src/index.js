// Fetches the Lime/Bolt/Dott GBFS feeds server-side, combines them into one
// JSON response, and caches that response at the edge for CACHE_TTL_SECONDS.
// Fetches happen only when a request actually arrives — there's no cron
// trigger pre-warming this. The Cache API is what makes repeated requests
// inside the TTL window free of any origin fetch.
//
// Future paid API keys: add with `wrangler secret put <NAME>` (never in
// this file or wrangler.toml's [vars], both of which are committed to
// git). Reference as env.<NAME>, e.g. add a header in fetchOperatorFeed:
//   headers: { Authorization: `Bearer ${env.SOME_OPERATOR_API_KEY}` }

const CACHE_TTL_SECONDS = 60;

const OPERATORS = [
  { id: "lime", urlKey: "LIME_GBFS_URL" },
  { id: "bolt", urlKey: "BOLT_GBFS_URL" },
  { id: "dott", urlKey: "DOTT_GBFS_URL" },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function fetchOperatorFeed(op, env) {
  const url = env[op.urlKey];
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/vehicles") {
      return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    }

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/vehicles`, { method: "GET" });

    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const results = await Promise.all(OPERATORS.map((op) => fetchOperatorFeed(op, env)));
    const body = {};
    OPERATORS.forEach((op, i) => {
      body[op.id] = results[i];
    });

    const response = new Response(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        ...CORS_HEADERS,
      },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
