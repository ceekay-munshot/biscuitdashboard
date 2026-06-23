# Biscuit Market Intelligence — India Pricing Dashboard

A single-file, zero-build market-intelligence dashboard for the Indian biscuit
industry. It tracks biscuit brands across e-commerce, quick-commerce and Google
Trends, with **price-per-gram (₹/g)** as the hero metric — plus discount vs MRP,
categories, pack sizes, reviews, shelf life, an emerging-brands radar and a
seeded market-share view. The entire app is one `index.html` (inline CSS + JS,
no framework, no bundler), served from a Cloudflare Worker with a KV-backed
`/api/history` route. E-commerce data is live-scraped; quick-commerce, Trends
and market share are seeded and editable.

## Reports & exports

Two one-click exports from the header:

- **⤓ Export Excel** — a styled, multi-sheet `.xlsx` (xlsx-js-style).
- **📰 Get Insight → *Biscuit Insights*** — the marquee report. One click
  composes the **whole dashboard into a colourful editorial newspaper PDF**
  (`Biscuit-Insights-<date>.pdf`) and downloads it — no print dialog. It is
  built as fixed-size **A4 pages (794×1123 px @96dpi)**, one section per page,
  each rendered to a full-bleed PDF page with **html2canvas + jsPDF**.
  Page count is **dynamic** — only sections backed by data are emitted (today:
  Front, Pricing, Category, Competition, Channels, Health, Trends, Last Word =
  8 pages) — and every page is laid out to fill completely. All copy and tables
  are generated from the **live data layer** (`npData()` / `npPages()` are pure
  and unit-tested); nothing is fabricated and every estimate/claim is labelled.
  Newsprint palette (`#FAF6EE` / `#16161D`) + brand accents; Playfair Display,
  Fraunces, Newsreader and IBM Plex Mono load lazily on first click.

## Build roadmap (12 steps)

- [x] **Step 1 — Scaffold, entities & deploy.** Single-file shell, design system,
  entity model (14 brands / 6 groups / 7 categories), router, branded empty
  state, animated fetch-progress screen, admin panel, and the Cloudflare
  Worker + KV `/api/history` deploy files.
- [ ] **Step 2 — Live scraping engine** (e-commerce) + price-per-gram parsing.
- [ ] **Step 3 — Exec-summary cards & dashboard stats** (with real data).
- [ ] **Step 4 — Price-per-gram charts & league table.**
- [ ] **Step 5 — Discount vs MRP, reviews & shelf life.**
- [ ] **Step 6 — Brand detail view.**
- [ ] **Step 7 — Category view.**
- [ ] **Step 8 — Pack-size view.**
- [ ] **Step 9 — Google Trends tab** (seeded + editable).
- [ ] **Step 10 — Emerging-brands radar.**
- [ ] **Step 11 — Market-share tab** (seeded).
- [ ] **Step 12 — Snapshot history + Excel export.**

## Stack

- **Frontend:** one `index.html` — inline `<style>` + `<script>`, vanilla ES6.
  CDNs: Google Fonts, Chart.js 4.4.1 (async) and xlsx-js-style 1.2.0 (defer);
  html2canvas 1.4.1 + jsPDF 2.5.1 and the newspaper fonts (Playfair Display,
  Fraunces, Newsreader, IBM Plex Mono) are lazy-loaded the first time
  **Get Insight** is clicked.
- **Backend:** Cloudflare Worker (`worker.js`) serving static assets via the
  `ASSETS` binding and a KV-backed `/api/history` route.

## Run locally

```bash
npm run dev          # npx wrangler dev → http://localhost:8787
```

Open the URL, click **▶ Fetch Live Data** to watch the per-brand progress screen,
and press **Ctrl/Cmd + Shift + A** for the admin / system-info panel.

## Deploy (Cloudflare)

```bash
npx wrangler login   # one-time
npm run deploy       # npx wrangler deploy
```

The Worker deploys **before** any KV namespace exists — `/api/history` simply
returns an empty history until persistence is enabled.

### Enable history persistence (KV)

```bash
npx wrangler kv namespace create BISCUIT_HISTORY_KV
```

Then in `wrangler.jsonc`, uncomment the `kv_namespaces` block and paste the
printed namespace id over `REPLACE_WITH_KV_NAMESPACE_ID`, and redeploy.

## `/api/history`

| Method | Behaviour                                                                 |
| ------ | ------------------------------------------------------------------------- |
| `GET`  | `{ ok:true, history:[...] }` — returns `[]` when KV is unbound.            |
| `POST` | Persists a full array, `{history:[...]}`, or appends a single snapshot. Returns `503` when KV is unbound. |
