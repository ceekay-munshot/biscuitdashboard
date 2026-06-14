/**
 * Cloudflare Worker — Biscuit Market Intelligence Dashboard
 *
 *  • Serves the single-file dashboard (index.html + static assets) via the
 *    ASSETS binding.
 *  • /api/history — GET/POST price-snapshot history, backed by KV
 *    (binding: BISCUIT_HISTORY_KV, key: "history").
 *
 * Degrades gracefully when KV is NOT bound, so the Worker deploys cleanly
 * before the namespace exists:
 *    GET  → { ok:true, history:[] }
 *    POST → 503 (nothing to persist to)
 * It never throws on a missing binding.
 */

const HISTORY_KEY = 'history';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- CORS preflight ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ---- /api/history ----
    if (url.pathname === '/api/history') {
      const kv = env.BISCUIT_HISTORY_KV;

      // GET — return stored history (or empty when KV is absent / on any error).
      if (request.method === 'GET') {
        if (!kv) return json({ ok: true, history: [] });
        try {
          const raw = await kv.get(HISTORY_KEY);
          return json({ ok: true, history: raw ? JSON.parse(raw) : [] });
        } catch (e) {
          return json({ ok: true, history: [], error: String(e) });
        }
      }

      // POST — persist history. Accepts a full array, {history:[...]},
      // or a single snapshot object to append. 503 when KV is unbound.
      if (request.method === 'POST') {
        if (!kv) return json({ ok: false, error: 'KV namespace not bound' }, 503);
        try {
          const body = await request.json();
          let history;
          if (Array.isArray(body)) {
            history = body;
          } else if (body && Array.isArray(body.history)) {
            history = body.history;
          } else {
            const raw = await kv.get(HISTORY_KEY);
            history = raw ? JSON.parse(raw) : [];
            history.push(body);
          }
          await kv.put(HISTORY_KEY, JSON.stringify(history));
          return json({ ok: true, history });
        } catch (e) {
          return json({ ok: false, error: String(e) }, 500);
        }
      }

      return json({ ok: false, error: 'method not allowed' }, 405);
    }

    // ---- Everything else → static assets (SPA fallback handled by wrangler) ----
    return env.ASSETS.fetch(request);
  },
};
