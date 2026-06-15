/**
 * scripts/scrape.mjs — runs in GitHub Actions (Node 20, global fetch, no deps).
 *
 * Scrapes each brand on Amazon + BigBasket via Firecrawl, parses SKUs, and writes
 *   data/latest.json   = { scrapedAt, skus:[...] }
 *   data/history.json  = [ { ts, skuCount, brandsOk }, ... ]  (last 50)
 *
 * The FIRECRAWL_API_KEY lives only in the Actions secret — never in the client.
 * The parser below is the exact code verified by the project's parser tests.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ---------------- roster + search sources ---------------- */
const BRANDS = [
  {brand:"Good Day",             company:"Britannia"},
  {brand:"Bourbon",              company:"Britannia"},
  {brand:"Marie Gold",           company:"Britannia"},
  {brand:"NutriChoice",          company:"Britannia"},
  {brand:"Parle-G",              company:"Parle"},
  {brand:"Monaco",               company:"Parle"},
  {brand:"Hide & Seek",          company:"Parle"},
  {brand:"KrackJack",            company:"Parle"},
  {brand:"Dark Fantasy",         company:"ITC Sunfeast"},
  {brand:"Mom's Magic",          company:"ITC Sunfeast"},
  {brand:"Sunfeast Marie Light", company:"ITC Sunfeast"},
  {brand:"Oreo",                 company:"Mondelez"},
  {brand:"Unibic",               company:"Unibic"},
  {brand:"The Whole Truth",      company:"Emerging / D2C"},
];

const SEARCH = {
  Amazon:    b => `https://www.amazon.in/s?k=${encodeURIComponent(b + ' biscuits')}`,
  BigBasket: b => `https://www.bigbasket.com/ps/?q=${encodeURIComponent(b + ' biscuits')}`,
};

/* ============================================================
   PARSER  (moved verbatim from index.html — the tested code)
   ============================================================ */

function detectPlatform(url){
  if (/amazon\./i.test(url))    return 'Amazon';
  if (/bigbasket\./i.test(url)) return 'BigBasket';
  if (/flipkart\./i.test(url))  return 'Flipkart';
  return 'Web';
}

/* WEIGHT → grams. Returns { grams, label } or null. */
function parseWeightGrams(text){
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/×/g,'x');
  const U = '(kgs?|gms?|grams?|g)\\b';
  const toG = (n,u)=>{ let v=parseFloat(n); if(/^k/.test(u)) v*=1000; return v; };
  const unitLabel = u => /^k/.test(u) ? 'kg' : 'g';
  const inRange = g => g>=10 && g<=5000;
  const packM = t.match(/(?:pack|combo|set)\s+of\s+(\d+)/i);

  // (a) "N x W unit"  → N × W
  let m = t.match(new RegExp('(\\d+)\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*'+U,'i'));
  if (m){
    const n=parseInt(m[1],10), w=toG(m[2],m[3]), total=n*w;
    if (n>=1 && inRange(total)){
      const wl = `${m[2]} ${unitLabel(m[3])}`;
      return { grams:+total.toFixed(2), label: packM ? `Pack of ${n} × ${wl}` : `${n} × ${wl}` };
    }
  }
  // (a2) "W unit x N"  → W × N
  m = t.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*'+U+'\\s*x\\s*(\\d+)','i'));
  if (m){
    const w=toG(m[1],m[2]), n=parseInt(m[3],10), total=w*n;
    if (n>=1 && inRange(total)){
      const wl = `${m[1]} ${unitLabel(m[2])}`;
      return { grams:+total.toFixed(2), label: packM ? `Pack of ${n} × ${wl}` : `${n} × ${wl}` };
    }
  }

  // standalone tokens
  const re = new RegExp('(\\d+(?:\\.\\d+)?)\\s*'+U,'ig');
  const toks=[]; let mm;
  while((mm=re.exec(t))) toks.push({ g:toG(mm[1],mm[2]), label:`${mm[1]} ${unitLabel(mm[2])}` });

  // (b) "pack/combo/set of N" × single unit weight
  if (packM && toks.length){
    const n=parseInt(packM[1],10);
    const unit = /each/.test(t) ? toks[0] : toks.reduce((a,b)=> b.g<a.g?b:a);
    const total = n*unit.g;
    if (n>=2 && inRange(total)) return { grams:+total.toFixed(2), label:`Pack of ${n} × ${unit.label}` };
  }

  // (c) single weight — largest plausible token
  const plaus = toks.filter(x=>inRange(x.g));
  if (plaus.length){
    const best = plaus.reduce((a,b)=> b.g>a.g?b:a);
    return { grams:+best.g.toFixed(2), label:best.label };
  }
  return null;
}

/* CATEGORY — first keyword match wins, else "Other". */
function detectCategory(text){
  const t = String(text||'').toLowerCase();
  if (/cream|bourbon|cr[eè]me|sandwich|dark fantasy|jim ?jam/.test(t)) return 'Cream';
  if (/cookie|choco ?chip|butter cookie|good ?day/.test(t))           return 'Cookies';
  if (/digestive|oats?|ragi|multigrain|high ?fibre|fiber|nutri/.test(t)) return 'Digestive';
  if (/cracker|monaco|krack ?jack|salt(ed)?|namkeen/.test(t))         return 'Crackers';
  if (/rusk|toast/.test(t)) return 'Rusk';
  if (/wafer/.test(t))      return 'Wafer';
  return 'Other';
}

/* REVIEWS — null when absent. */
function parseRating(text){
  const t = String(text||'');
  let m = t.match(/([0-5](?:\.\d)?)\s*out of\s*5/i);
  if (m) return parseFloat(m[1]);
  m = t.match(/★\s*([0-5](?:\.\d)?)/);
  if (m) return parseFloat(m[1]);
  return null;
}
function parseReviewCount(text){
  const t = String(text||'');
  // "1,234 ratings" / "567 reviews"
  let m = t.match(/([\d,]+)\s*(ratings?|reviews?)/i);
  if (m) return parseInt(m[1].replace(/,/g,''),10);
  // Amazon search shows the count as a "(2.7K)" / "(2,345)" link
  m = t.match(/\((\d[\d,]*\.?\d*)\s*([kK])?\)/);
  if (m){ let n = parseFloat(m[1].replace(/,/g,'')); if (m[2]) n *= 1000; return Math.round(n); }
  return null;
}

/* PRICES — { selling, mrp } in ₹, or null.
   Handles Amazon's markdown quirks: amounts are doubled ("₹66₹66") and a
   per-unit price sits in parens ("(₹16.50₹16.50/100 g)"). The payable price is
   shown first, the struck MRP after a "M.R.P" label. */
function extractPrices(text){
  let t = String(text||'').replace(/,/g,'');
  // drop unit-price parentheticals like "(₹16.50₹16.50/100 g)" / "(₹5/100g)"
  t = t.replace(/\([^)]*\/\s*\d+\s*(?:g|kg|gm|ml|l)\b[^)]*\)/gi,' ');

  const re = /(?:₹|rs\.?|inr)\s*(\d+(?:\.\d{1,2})?)/ig;
  const amts = [];
  let m;
  while ((m = re.exec(t))){
    const after = t.slice(re.lastIndex, re.lastIndex+8);
    if (/^\s*\/\s*\d/.test(after)) continue;   // skip any leftover "₹5/100 g"
    amts.push(parseFloat(m[1]));
  }
  const sane = amts.filter(a=>a>=3 && a<=5000);
  if (!sane.length) return null;

  // explicit MRP label
  let mrp = null;
  const mm = t.match(/m\.?r\.?p\.?\s*[:.]?\s*(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d{1,2})?)/i);
  if (mm) mrp = parseFloat(mm[1]);

  // payable price = first amount shown; fall back to the min if the first looks
  // like the MRP (some layouts list MRP first).
  let selling = sane[0];
  if (mrp != null && selling > mrp) selling = Math.min(...sane);
  if (mrp == null){ const hi = Math.max(...sane); if (hi > selling) mrp = hi; }
  if (mrp != null && mrp < selling) mrp = null;
  return { selling, mrp };
}

function cleanName(s){
  return String(s||'')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,'')
    .replace(/\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/[*_`#>]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}

function absolutize(url, platform){
  if (/^https?:\/\//i.test(url)) return url;
  const base = platform==='Amazon' ? 'https://www.amazon.in'
            : platform==='BigBasket' ? 'https://www.bigbasket.com'
            : platform==='Flipkart' ? 'https://www.flipkart.com' : '';
  return url.startsWith('/') ? base+url : url;
}

const STOP = new Set(['the','and','for','with','pack','biscuit','biscuits','cookies']);
function brandTokensOf(brand){
  return brand.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>=3 && !STOP.has(w));
}

/* Brand attribution. The normalized full brand ("Parle-G" -> "parleg") must
   appear in the title or product URL — this stops a brand's search results from
   absorbing sibling brands (e.g. Parle-G search returns Monaco/Krackjack, whose
   URLs contain "parle" but not "parleg"). Falls back to all brand tokens in the
   title text for multi-word brands. */
const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
/* Amazon bakes the search keyword into every result URL's ref/dib params, so a
   brand string appears in EVERY url on its search page. Match only the product
   slug — the path segment before /dp/ — which holds the real product name. */
function urlSlug(url){
  const m = String(url||'').match(/\/([^\/]+)\/(?:dp|gp|p|pd|prd)\//i);
  return m ? m[1] : String(url||'').split(/[?#]/)[0];
}
function brandMatches(brand, text, url){
  const nb = norm(brand), nt = norm(text), ns = norm(urlSlug(url));
  if (nt.includes(nb) || ns.includes(nb)) return true;
  const toks = brandTokensOf(brand);
  return toks.length > 0 && toks.every(t => nt.includes(t));   // fallback: tokens in title
}

/* Brand -> category default, used only when keyword detection yields "Other".
   Glucose/Marie brands (Parle-G, Marie Gold, Sunfeast Marie Light) and
   The Whole Truth are intentionally left to keyword/Other. */
const BRAND_CAT = {
  "Good Day":"Cookies", "Bourbon":"Cream", "NutriChoice":"Digestive",
  "Monaco":"Crackers", "KrackJack":"Crackers", "Dark Fantasy":"Cream",
  "Hide & Seek":"Cookies", "Oreo":"Cream", "Mom's Magic":"Cookies", "Unibic":"Cookies",
};
function categoryFor(name, brand){
  // Detect from the product-name head (before the first comma) so trailing
  // ingredient lists ("…, Sugar, Salt, …") don't trip category keywords.
  const head = String(name||'').split(',')[0];
  const c = detectCategory(head);
  return c !== 'Other' ? c : (BRAND_CAT[brand] || 'Other');
}

function extractSKU(link, block, brand, company, platform){
  const name = cleanName(link.text);

  // Weight: prefer the title; fall back to the block with unit-price
  // denominators ("/100 g") stripped so they can't be read as a pack weight.
  let w = parseWeightGrams(name);
  if (!w) w = parseWeightGrams(block.replace(/\/\s*\d+\s*(?:g|kg|ml|l)\b/gi,' '));
  if (!w) return null;
  const weightGrams = w.grams, packLabel = w.label;

  const prices = extractPrices(block);
  if (!prices || !prices.selling) return null;
  const selling = prices.selling;
  const mrp = prices.mrp != null ? prices.mrp : selling;
  const discount = mrp > selling ? +(((mrp-selling)/mrp)*100).toFixed(1) : 0;

  if (selling < 3 || selling > 3000) return null;
  const pricePerGram = +(selling/weightGrams).toFixed(3);
  const mrpPerGram    = +(mrp/weightGrams).toFixed(3);
  if (pricePerGram < 0.05 || pricePerGram > 6) return null;

  const url = absolutize(link.url, platform);
  return {
    brand, company,
    name: name.slice(0,130),
    mrp, selling, discount,
    weightGrams, packLabel, pricePerGram, mrpPerGram,
    category: categoryFor(name, brand),
    platform,
    rating: parseRating(block),
    reviewCount: parseReviewCount(block),
    url,
    isProductPage: /\/dp\/|\/p\/|\/pd\/|pid=/i.test(url),
    isLive: true,
  };
}

const isProductUrl = u => /\/dp\/|\/gp\/|\/p\/|\/pd\/|\/prd\/|pid=/i.test(u);

function parseSKUsFromPage(markdown, pageUrl, brand, company){
  const out = [];
  if (!markdown) return out;
  const platform = detectPlatform(pageUrl);

  // All links, in document order.
  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  const all = [];
  let m;
  while ((m = linkRe.exec(markdown))){
    all.push({ idx:m.index, text:(m[1]||'').trim(), url:(m[2]||'').trim() });
  }

  // Product titles = BOLD link text pointing at a product page. On Amazon the
  // title is the only bold /dp/ link; price/rating/delivery links are not bold.
  const titles = all.filter(l => /^\*\*/.test(l.text) && isProductUrl(l.url));

  if (titles.length){
    for (let i=0;i<titles.length;i++){
      const L = titles[i];
      if (!brandMatches(brand, L.text, L.url)) continue;
      // Block runs to the next title (any brand), capped — the price/rating for
      // this product sit between its title and the next one.
      const nextIdx = (i+1<titles.length) ? titles[i+1].idx : markdown.length;
      const block = markdown.slice(L.idx, Math.min(nextIdx, L.idx+1600, markdown.length));
      const sku = extractSKU(L, block, brand, company, platform);
      if (sku) out.push(sku);
    }
    return out;
  }

  // Fallback (no bold /dp/ titles — e.g. BigBasket): older brand/length/price
  // heuristic with all links as block boundaries.
  const tokens = brandTokensOf(brand);
  for (let i=0;i<all.length;i++){
    const L = all[i];
    if (L.idx>0 && markdown[L.idx-1]==='!') continue;     // image
    const text = L.text, url = L.url;
    if (text.length<15 || text.length>250) continue;
    if (/^https?:\/\//i.test(text)) continue;
    if (/^\(?\d+%\s*off\)?$/i.test(text)) continue;
    if (/^(₹|rs\.?|inr|m\.?r\.?p)/i.test(text) && (text.replace(/[^a-z]/ig,'').length < 5)) continue;
    if (!brandMatches(brand, text, url)) continue;
    const nextIdx = (i+1<all.length) ? all[i+1].idx : markdown.length;
    const block = markdown.slice(L.idx, Math.min(nextIdx, L.idx+900, markdown.length));
    const sku = extractSKU(L, block, brand, company, platform);
    if (sku) out.push(sku);
  }
  return out;
}

const dedupeKey = s => (s.name||'').slice(0,30)+'|'+s.weightGrams+'|'+s.selling;

/* ============================================================
   FIRECRAWL + MAIN
   ============================================================ */
async function firecrawl(url, key){
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method:'POST',
    headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ url, formats:['markdown'], onlyMainContent:false }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok){
    const t = await res.text().catch(()=> '');
    throw new Error(`firecrawl ${res.status}: ${t.slice(0,150)}`);
  }
  const data = await res.json();
  if (data.success === false) throw new Error('firecrawl success:false');
  return (data.data && data.data.markdown) || '';
}

async function main(){
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key){ console.error('FIRECRAWL_API_KEY not set'); process.exit(1); }

  // Debug raw-markdown capture — OFF by default. Set DEBUG_DUMP_BRANDS to a
  // comma-separated brand list (via the Scrape workflow's debug_brands input) to
  // write those pages' raw Firecrawl markdown to data/_debug/ for parser work.
  // Reuses the normal scrape fetch, so it costs no extra Firecrawl calls.
  const DUMP_BRANDS = (process.env.DEBUG_DUMP_BRANDS||'').split(',').map(s=>s.trim()).filter(Boolean);

  const allSkus = [], globalSeen = new Set();
  let brandsOk = 0;

  for (const { brand, company } of BRANDS){
    const urls = Object.values(SEARCH).map(fn => fn(brand));
    const seen = new Set();
    const brandSkus = [];

    for (const url of urls){
      try {
        const md = await firecrawl(url, key);
        if (DUMP_BRANDS.includes(brand)){
          mkdirSync('data/_debug', { recursive:true });
          writeFileSync(`data/_debug/${brand.replace(/[^a-z0-9]+/gi,'_')}.${detectPlatform(url)}.md`, md);
          console.log(`  [debug] dumped ${brand} ${detectPlatform(url)} (${md.length} chars)`);
        }
        for (const s of parseSKUsFromPage(md, url, brand, company)){
          const k = dedupeKey(s);
          if (seen.has(k)) continue;
          seen.add(k); brandSkus.push(s);
        }
      } catch(e){
        console.log(`  ! ${brand} ${detectPlatform(url)}: ${e.message}`);
      }
    }

    let added = 0;
    for (const s of brandSkus){
      const k = dedupeKey(s);
      if (globalSeen.has(k)) continue;
      globalSeen.add(k); allSkus.push(s); added++;
    }
    if (added) brandsOk++;
    console.log(`${brand.padEnd(22)} ${added} SKUs`);
  }

  const scrapedAt = new Date().toISOString();
  mkdirSync('data', { recursive:true });
  writeFileSync('data/latest.json', JSON.stringify({ scrapedAt, skus: allSkus }, null, 2));

  let history = [];
  try { if (existsSync('data/history.json')) history = JSON.parse(readFileSync('data/history.json','utf8')); } catch(_){}
  if (!Array.isArray(history)) history = [];
  history.push({ ts: scrapedAt, skuCount: allSkus.length, brandsOk });
  history = history.slice(-50);
  writeFileSync('data/history.json', JSON.stringify(history, null, 2));

  console.log(`\nTOTAL: ${allSkus.length} SKUs · ${brandsOk}/${BRANDS.length} brands OK · ${scrapedAt}`);
}

/* Run only when invoked directly (so tests can import the parser). */
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export {
  BRANDS, SEARCH,
  parseWeightGrams, detectCategory, parseRating, parseReviewCount,
  extractPrices, cleanName, detectPlatform, parseSKUsFromPage, dedupeKey,
};
