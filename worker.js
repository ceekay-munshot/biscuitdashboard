/**
 * Cloudflare Worker — Biscuit Market Intelligence Dashboard
 *
 * Static-asset server only. Scraping happens in GitHub Actions
 * (scripts/scrape.mjs), which commits data/latest.json + data/history.json;
 * Cloudflare's git build deploys them and the browser reads the JSON directly.
 * There is no runtime scraping and no server-side secret.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    // Everything else → static assets (index.html, data/*.json, …).
    // SPA fallback (configured in wrangler.jsonc) handles unknown paths.
    return env.ASSETS.fetch(request);
  },
};
