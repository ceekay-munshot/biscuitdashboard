/**
 * scripts/gen-trends.mjs — fetch REAL Google Trends in CI (server-side, no CORS),
 * writing data/trends.json in the shape the dashboard already reads.
 *
 * Google Trends compares ≤5 terms per request and is RELATIVE within a request,
 * so terms are batched in groups of ≤5 with a common ANCHOR in every batch, then
 * normalized to that anchor for cross-batch comparability.
 *
 * BEST-EFFORT: reads the existing trends.json first; any key that fails to refresh
 * KEEPS its last-good value marked {stale:true}. Never fabricates, never writes
 * empty. (Google often rate-limits datacenter IPs — fallback is the norm.)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BRANDS = ['Parle-G','Good Day','Bourbon','Marie Gold','NutriChoice','Monaco','Hide & Seek',
  'KrackJack','Dark Fantasy',"Mom's Magic",'Sunfeast Marie Light','Oreo','Unibic','The Whole Truth'];
const CATEGORIES = ['Cookies','Digestive','Cream','Crackers','Rusk','Wafer'];
const BRAND_ANCHOR = 'Parle-G';   // most-searched biscuit term — present in every brand batch
const CAT_ANCHOR   = 'biscuit';   // normalization anchor for categories (not itself a category)

const GEO='IN', TIME='today 12-m', HL='en-US', TZ=-330;
const UA = {
  'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
  'Accept-Language':'en-US,en;q=0.9',
};
const sleep = ms => new Promise(r=>setTimeout(r, ms));
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const stripPrefix = t => { const i = t.indexOf('{'); if (i<0) throw new Error('no JSON in response'); return t.slice(i); };

// Reduce a (weekly) interest series to 12 monthly buckets (averaged).
function to12(series){
  if (!series || !series.length) return null;
  const out = [];
  for (let m=0;m<12;m++){
    const a=Math.floor(m*series.length/12), b=Math.max(Math.floor((m+1)*series.length/12), a+1);
    out.push(Math.round(mean(series.slice(a,b))));
  }
  return out;
}
const direction = interest => {
  const f=mean(interest.slice(0,3)), l=mean(interest.slice(-3)), d=l-f;
  return d>=4 ? 'rising' : d<=-4 ? 'falling' : 'flat';
};

// Scale fetched series to 0–100 (global max) + merge with last-good (stale) for misses.
function buildOutput(names, raw, prevMap, fetchedAt){
  const fetched = names.filter(n => Array.isArray(raw[n]) && raw[n].length===12);
  const gmax = Math.max(1, ...fetched.flatMap(n=>raw[n]));
  const out = {};
  for (const n of names){
    if (fetched.includes(n)){
      const interest = raw[n].map(v => Math.max(0, Math.min(100, Math.round(v/gmax*100))));
      out[n] = { interest, latest: interest[11], direction: direction(interest), source:'google-trends-live', fetchedAt, stale:false };
    } else if (prevMap[n]){
      out[n] = { interest:prevMap[n].interest, latest:prevMap[n].latest, direction:prevMap[n].direction,
                 source: prevMap[n].source || 'seed', fetchedAt: prevMap[n].fetchedAt || null, stale:true };
    }
  }
  return { out, fetchedCount: fetched.length };
}

async function getCookie(){
  try {
    const r = await fetch('https://trends.google.com/?geo='+GEO, { headers:UA, signal:AbortSignal.timeout(20000) });
    const sc = r.headers.get('set-cookie');
    if (sc) return sc.split(/,(?=[^;,]+=)/).map(c=>c.split(';')[0].trim()).join('; ');
  } catch(e){ console.log('  cookie fetch failed:', e.message); }
  return '';
}
async function gtFetch(url, cookie){
  const r = await fetch(url, { headers: cookie ? {...UA, cookie} : UA, signal:AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP '+r.status);
  return JSON.parse(stripPrefix(await r.text()));
}
async function fetchBatch(keywords, cookie){
  const req = { comparisonItem: keywords.map(kw=>({keyword:kw, geo:GEO, time:TIME})), category:0, property:'' };
  const ex = await gtFetch(`https://trends.google.com/trends/api/explore?hl=${HL}&tz=${TZ}&req=${encodeURIComponent(JSON.stringify(req))}`, cookie);
  const w = (ex.widgets||[]).find(x=>x.id==='TIMESERIES');
  if (!w) throw new Error('no TIMESERIES widget');
  await sleep(700);
  const ml = await gtFetch(`https://trends.google.com/trends/api/widgetdata/multiline?hl=${HL}&tz=${TZ}&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${w.token}`, cookie);
  const tl = (ml.default && ml.default.timelineData) || [];
  const out = {};
  keywords.forEach((kw,i)=>{ out[kw] = to12(tl.map(p => (p.value && p.value[i]) || 0)); });
  return out;
}

// Fetch a set, anchor-normalized across batches. Returns { name: number[12] } for refreshed keys.
async function fetchSet(items, anchor, cookie){
  const others = items.filter(x=>x!==anchor);
  const raw = {};
  let anchorRef = null;
  for (let i=0;i<others.length;i+=4){
    const group = others.slice(i, i+4);
    let batch;
    for (let attempt=1; attempt<=2 && !batch; attempt++){
      try { batch = await fetchBatch([anchor, ...group], cookie); }
      catch(e){ console.log(`  batch [${group.join(', ')}] try ${attempt}: ${e.message}`); if (attempt<2) await sleep(4000); }
    }
    if (!batch) { await sleep(1500); continue; }
    const aMean = mean(batch[anchor]||[]);
    if (!aMean){ console.log('  anchor empty for batch — skipping'); continue; }
    if (anchorRef==null){ anchorRef = aMean; raw[anchor] = batch[anchor]; }
    const factor = anchorRef/aMean;
    for (const kw of group) if (batch[kw]) raw[kw] = batch[kw].map(v=>v*factor);
    await sleep(1500);
  }
  return raw;
}

async function main(){
  let prev = {};
  try { if (existsSync('data/trends.json')) prev = JSON.parse(readFileSync('data/trends.json','utf8')); } catch(_){}
  const prevBrands = prev.brands || {}, prevCats = prev.categories || {};

  const cookie = await getCookie();
  const fetchedAt = new Date().toISOString();

  const brandRaw = await fetchSet(BRANDS, BRAND_ANCHOR, cookie);
  const catRaw   = await fetchSet(CATEGORIES, CAT_ANCHOR, cookie);

  const B = buildOutput(BRANDS, brandRaw, prevBrands, fetchedAt);
  const C = buildOutput(CATEGORIES, catRaw, prevCats, fetchedAt);

  if (!Object.keys(B.out).length && !Object.keys(C.out).length){
    console.error('No data fetched and no last-good to keep — not writing (no fabrication).');
    process.exit(1);
  }
  const liveTotal = B.fetchedCount + C.fetchedCount;
  const out = {
    source: liveTotal ? 'google-trends-live' : 'google-trends-live (all last-good)',
    geo: GEO, updated: fetchedAt.slice(0,10), timeframe:'last 12 months', fetchedAt,
    note: 'Relative search interest (0–100), NOT sales. Fetched live from Google Trends in CI; '
        + 'any value that could not refresh keeps its last-good and is flagged stale.',
    brands: B.out, categories: C.out,
  };
  writeFileSync('data/trends.json', JSON.stringify(out, null, 2));
  const staleB = Object.values(B.out).filter(x=>x.stale).length;
  const staleC = Object.values(C.out).filter(x=>x.stale).length;
  console.log(`trends.json written — brands ${B.fetchedCount}/${BRANDS.length} live (${staleB} stale), categories ${C.fetchedCount}/${CATEGORIES.length} live (${staleC} stale) · ${fetchedAt}`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { to12, direction, buildOutput, stripPrefix };
