/**
 * Cloudflare Worker — Biscuit Market Intelligence Dashboard
 *
 *  • Serves the single-file dashboard (index.html + static assets) via ASSETS.
 *  • POST /api/scrape  — Firecrawl proxy. The FIRECRAWL_API_KEY lives ONLY here
 *    (uploaded as a Worker secret by the GitHub Action); it never reaches the
 *    client. SSRF-guarded to the allow-listed retail hosts.
 *  • GET/POST /api/history — price-snapshot history, backed by KV
 *    (binding: BISCUIT_HISTORY_KV). Degrades gracefully when KV is unbound.
 */

const HISTORY_KEY = 'history';

// SSRF allow-list for the scrape proxy.
const SCRAPE_ALLOWED = ['amazon.in', 'bigbasket.com', 'flipkart.com'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const jsonError = (message, status = 500, extra = {}) =>
  json({ ok: false, error: message, ...extra }, status);

/**
 * POST /api/scrape  { url }
 * Proxies to Firecrawl with the server-side key and returns { ok, markdown }.
 */
async function handleScrape(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const url = body && body.url;
  if (!url || typeof url !== 'string') return jsonError('missing "url"', 400);

  // SSRF guard — hostname must be (a subdomain of) an allow-listed retail host.
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return jsonError('invalid url', 400);
  }
  const allowed = SCRAPE_ALLOWED.some((d) => hostname === d || hostname.endsWith('.' + d));
  if (!allowed) return jsonError('host not allowed', 400, { hostname });

  const key = env.FIRECRAWL_API_KEY;
  if (!key) return jsonError('FIRECRAWL_API_KEY not set', 500);

  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: false }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return jsonError(`firecrawl ${res.status}: ${text.slice(0, 200)}`, 502);
    }
    const data = await res.json();
    if (data.success === false) {
      return jsonError(`firecrawl: ${String(data.error || 'failed').slice(0, 200)}`, 502);
    }
    return json({ ok: true, markdown: (data.data && data.data.markdown) || '' });
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'firecrawl timeout' : String((e && e.message) || e);
    return jsonError(`scrape error: ${msg.slice(0, 200)}`, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- CORS preflight ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ---- /api/scrape (Firecrawl proxy; key stays server-side) ----
    if (url.pathname === '/api/scrape') {
      if (request.method === 'POST') return handleScrape(request, env);
      return jsonError('method not allowed', 405);
    }

    // ---- /api/history (KV-backed, graceful when unbound) ----
    if (url.pathname === '/api/history') {
      const kv = env.BISCUIT_HISTORY_KV;

      if (request.method === 'GET') {
        if (!kv) return json({ ok: true, history: [] });
        try {
          const raw = await kv.get(HISTORY_KEY);
          return json({ ok: true, history: raw ? JSON.parse(raw) : [] });
        } catch (e) {
          return json({ ok: true, history: [], error: String(e) });
        }
      }

      if (request.method === 'POST') {
        if (!kv) return jsonError('KV namespace not bound', 503);
        try {
          const body = await request.json();
          let history;
          if (Array.isArray(body)) history = body;
          else if (body && Array.isArray(body.history)) history = body.history;
          else {
            const raw = await kv.get(HISTORY_KEY);
            history = raw ? JSON.parse(raw) : [];
            history.push(body);
          }
          await kv.put(HISTORY_KEY, JSON.stringify(history));
          return json({ ok: true, history });
        } catch (e) {
          return jsonError(String(e), 500);
        }
      }

      return jsonError('method not allowed', 405);
    }

    // ---- Static assets (SPA fallback handled by wrangler) ----
    return env.ASSETS.fetch(request);
  },
};
