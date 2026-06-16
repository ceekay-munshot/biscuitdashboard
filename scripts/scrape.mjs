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

// Search URL builders take a RAW query string.
const SEARCH = {
  Amazon:    q => `https://www.amazon.in/s?k=${encodeURIComponent(q)}`,
  BigBasket: q => `https://www.bigbasket.com/ps/?q=${encodeURIComponent(q)}`,
};

// Coverage queries (discover mode) so thin/empty categories + D2C brands populate.
// Products are classified to a brand/company; unknown ones surface as Emerging / D2C.
const COVERAGE = [
  { label:'Rusk',  q:'Britannia rusk' },
  { label:'Rusk',  q:'rusk toast biscuit' },
  { label:'Wafer', q:'wafer biscuit' },
  { label:'Wafer', q:'Dukes wafer' },
  { label:'Wafer', q:'Unibic wafer' },
  { label:'D2C',   q:'The Whole Truth cookies' },
  { label:'D2C',   q:'Open Secret cookies' },
];

// Company aliases for classifying discovered products to a known company group.
const COMPANY_ALIASES = {
  "Britannia": ["britannia"],
  "Parle": ["parle"],
  "ITC Sunfeast": ["sunfeast","itc"],
  "Mondelez": ["cadbury","oreo","mondelez"],
  "Unibic": ["unibic"],
};

// Known SUB-brands beyond the tracked roster → company (matched against the title)
// so e.g. Britannia's "Toastea" rusk doesn't get mislabelled Emerging/D2C.
const ALIASES = [
  ["Toastea","Britannia"],["Milk Bikis","Britannia"],["Jim Jam","Britannia"],["Treat","Britannia"],
  ["Tiger","Britannia"],["50-50","Britannia"],["Pure Magic","Britannia"],["Little Hearts","Britannia"],
  ["Hide & Seek","Parle"],["Monaco","Parle"],["KrackJack","Parle"],["20-20","Parle"],
  ["Magix","Parle"],["Happy Happy","Parle"],["Milano","Parle"],
  ["Dark Fantasy","ITC Sunfeast"],["Bounce","ITC Sunfeast"],["Mom's Magic","ITC Sunfeast"],
  ["Farmlite","ITC Sunfeast"],["Sunfeast","ITC Sunfeast"],["Nice","ITC Sunfeast"],
  ["Oreo","Mondelez"],["Chocobakes","Mondelez"],["Bournvita","Mondelez"],
].map(([brand,company])=>({brand,company}));

// Curated allowlist of real independent / D2C / regional biscuit & wafer brands
// (outside the 6 tracked groups). Matched against the title so genuine new
// players surface cleanly; anything unmatched falls to "Other" (never faked).
const EMERGING_BRANDS = [
  'Dukes','Open Secret','Anmol','Priyagold','Bisk Farm','McVitie','Cremica','Pillsbury',
  'Tasty Treat','Karachi','Bonn','Patanjali','Sri Sri','RiteBite','Slurrp Farm','Early Foods',
  'Timios','Munchilicious','Wholsum','EatAnytime','Cookie Man','Yumznack','PADMAZ',
].map(brand=>({brand, company:'Emerging / D2C'}));

// Non-brand words that must never become a derived emerging-brand label.
const JUNK = new Set([
  'pack','combo','set','box','of','midbreak','rusk','rusks','toast','toastea','biscuit','biscuits',
  'cookie','cookies','wafer','wafers','cracker','crackers','assorted','value','premium','classic',
  'unflavoured','unflavored','gram','grams','whole','foxtail','tasty','health','protein','energy','gift',
  'maida','pineapple','mango','lemon','rose','spicy','chilli','onion','garlic','potato','mocha','coffee','cheese',
  'original','pure','family','jar','pouch','the','with','and','for','flavour','flavor','flavored','flavoured',
  'crispy','crunchy','snack','snacks','tea','special','no','mini','minis','suji','rava','combo','box',
  'chocolate','choco','vanilla','strawberry','orange','butter','cashew','almond','coconut','elaichi','elachi',
  'milk','cream','creme','crme','jeera','salt','salted','masala','pista','pistachio','walnut','walnuts','oats','ragi',
  'millet','grain','multigrain','multi','jaggery','atta','wheat','digestive','glucose','marie','sugar','free',
  'gluten','high','fibre','fiber','marble','cake','palm','oil','without','plain','mixed','little','bite','bites',
  'roll','rolls','delight','nut','nuts','crunch','choc','dark','white','fruit','honey','badam','kaju','desi',
]);

// Derive a clean emerging-brand label: leading proper-noun token(s). Junk and
// numbers are skipped (digits also stripped before the junk check so "Pack75"→
// "pack"→junk). Brand-less generic titles return '' → "Other", never a fake brand.
function deriveBrand(name){
  const picked = [];
  for (const raw of cleanName(name).split(/[\s\-–—]+/)){          // split on spaces and hyphens
    const w = raw.replace(/[^A-Za-z0-9&'.]/g,'').replace(/^['.]+|['.]+$/g,'');
    if (!w || w.length<3) { if (picked.length) break; else continue; }
    const base = w.toLowerCase().replace(/\d+/g,'');
    if (/^\d/.test(w) || JUNK.has(base) || JUNK.has(w.toLowerCase())) { if (picked.length) break; else continue; }
    picked.push(w);
    if (picked.length >= 2) break;
  }
  return picked.join(' ').replace(/\s+/g,' ').trim();
}

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

/* Repair UTF-8-as-Latin1 / Windows-1252 mojibake in scraped text (e.g. "Crème"
   shows up as "CrÃ¨me" — and because Amazon title-cases names, the "Ã" lead can
   arrive lowercased as "ã", giving "Crã¨Me"). Both leads are handled via the
   UTF-8 continuation-byte formula; smart punctuation is mapped explicitly. */
function repairText(s){
  if (s == null) return s;
  let t = String(s);
  // Smart punctuation: "\u00E2\u20AC" then a marker char -> quote/dash/ellipsis.
  t = t.replace(/\u00E2\u20AC(.)/g, (_, c) => {
    switch (c.charCodeAt(0)){
      case 0x2122: case 0x02DC: return "'";    // right/left single quote
      case 0x0153: return '"';                 // left double quote
      case 0x009D: case 0x201D: return '"';    // right double quote
      case 0x201C: return '\u2013';            // en dash
      case 0x00A6: return '\u2026';            // ellipsis
      default: return '';                       // drop stray artifact
    }
  });
  // Accented letters: "\u00C3"/"\u00E3" (incl. Amazon's title-cased lead) + a
  // UTF-8 continuation byte -> C3 YY decodes to U+00(0x40+YY); covers e-acute,
  // e-grave, a-circumflex, o-circumflex, n-tilde, a-grave, etc.
  t = t.replace(/[\u00C3\u00E3]([\u0080-\u00BF])/g, (_, y) => String.fromCharCode(0x40 + y.charCodeAt(0)));
  // Stray 2-byte lead "\u00C2"/"\u00E2" + Latin-1 supplement char -> drop lead.
  t = t.replace(/[\u00C2\u00E2]([\u00A0-\u00BF])/g, (_, y) => y);
  // leftover non-breaking spaces -> normal space
  t = t.replace(/\u00A0/g, ' ');
  return t;
}

/* Remove markdown link targets and bare URLs from a block so their query
   tokens (Amazon's "dib=" base64, which can contain "rs6"-like substrings)
   can't be misread as prices/weights. Keeps the bracketed link TEXT, where the
   visible price actually lives. */
function stripUrls(s){
  return String(s||'')
    .replace(/\]\([^)]*\)/g, ']')        // [text](url) -> [text]
    .replace(/https?:\/\/\S+/gi, ' ');   // any bare url
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
  const name = repairText(cleanName(link.text));   // fix UTF-8 mojibake at the source
  // Read prices/reviews/weight from a URL-FREE view of the block. Link targets
  // (Amazon's base64 "dib=" tokens) can contain substrings like "rs6" that the
  // ₹/Rs price regex would otherwise misread as a price.
  const text = stripUrls(block);

  // Weight: prefer the title; fall back to the (URL-free) block with unit-price
  // denominators ("/100 g") stripped so they can't be read as a pack weight.
  let w = parseWeightGrams(name);
  if (!w) w = parseWeightGrams(text.replace(/\/\s*\d+\s*(?:g|kg|ml|l)\b/gi,' '));
  if (!w) return null;
  const weightGrams = w.grams, packLabel = w.label;

  const prices = extractPrices(text);
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
    rating: parseRating(text),
    reviewCount: parseReviewCount(text),
    url,
    isProductPage: /\/dp\/|\/p\/|\/pd\/|pid=/i.test(url),
    isLive: true,
  };
}

const isProductUrl = u => /\/dp\/|\/gp\/|\/p\/|\/pd\/|\/prd\/|pid=/i.test(u);

// Classify a discovered product → tracked brand → known sub-brand alias →
// known company → cleaned emerging-brand label.
function earliestMatch(list, name, url){
  const nt = norm(name);
  let best=null, bestPos=Infinity, bestLen=0;
  for (const k of list){
    if (!brandMatches(k.brand, name, url)) continue;
    const nb = norm(k.brand), pos = nt.indexOf(nb), p = pos<0 ? 9999 : pos;
    if (p < bestPos || (p===bestPos && nb.length>bestLen)){ best={brand:k.brand, company:k.company}; bestPos=p; bestLen=nb.length; }
  }
  return best;
}
function classifyBrand(name, url){
  return earliestMatch(BRANDS, name, url)                          // 1) tracked roster (most specific)
      || earliestMatch(ALIASES, name, url)                         // 2) known sub-brand aliases
      || (()=>{ const nt=norm(name);                               // 3) known company word
           for (const [co, al] of Object.entries(COMPANY_ALIASES)) if (al.some(a=>nt.includes(a))) return { brand:co, company:co };
           return null; })()
      || earliestMatch(EMERGING_BRANDS, name, url)                 // 4) curated independent/D2C brands
      || { brand:'Other', company:'Emerging / D2C' };              // 5) unrecognized → Other (never a fabricated label)
}

// True when a page looks bot-blocked / product-less (e.g. BigBasket's pincode/JS wall).
function looksBlocked(markdown){
  if (!markdown) return true;
  if (/\/pd\//i.test(markdown)) return false;                       // has product links
  return (markdown.match(/₹/g)||[]).length === 0;                   // no prices at all
}

/* Core page parser. `resolve(text,url)` returns {brand,company} or null.
   - brand mode  : resolve = brandMatches filter (keeps only that brand)
   - discover mode: resolve = classifyBrand (attributes every product) */
function parsePage(markdown, pageUrl, resolve){
  const out = [];
  if (!markdown) return out;
  const platform = detectPlatform(pageUrl);

  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  const all = []; let m;
  while ((m = linkRe.exec(markdown))) all.push({ idx:m.index, text:(m[1]||'').trim(), url:(m[2]||'').trim() });

  // Amazon: products are BOLD /dp/ titles. BigBasket: products are /pd/ links
  // (not bold) — used only when there are no bold titles.
  const bold = all.filter(l => /^\*\*/.test(l.text) && isProductUrl(l.url));
  const candidates = bold.length
    ? bold
    : all.filter(l => /\/pd\//i.test(l.url) && l.text.length>=10 && l.text.length<=250 && !/^https?:/i.test(l.text));

  if (candidates.length){
    for (let i=0;i<candidates.length;i++){
      const L = candidates[i];
      const who = resolve(L.text, L.url);
      if (!who) continue;
      const nextIdx = (i+1<candidates.length) ? candidates[i+1].idx : markdown.length;
      const block = markdown.slice(L.idx, Math.min(nextIdx, L.idx+1600, markdown.length));
      const sku = extractSKU(L, block, who.brand, who.company, platform);
      if (sku) out.push(sku);
    }
    return out;
  }

  // Fallback heuristic for other layouts.
  for (let i=0;i<all.length;i++){
    const L = all[i];
    if (L.idx>0 && markdown[L.idx-1]==='!') continue;     // image
    const text = L.text, url = L.url;
    if (text.length<15 || text.length>250) continue;
    if (/^https?:\/\//i.test(text)) continue;
    if (/^\(?\d+%\s*off\)?$/i.test(text)) continue;
    if (/^(₹|rs\.?|inr|m\.?r\.?p)/i.test(text) && (text.replace(/[^a-z]/ig,'').length < 5)) continue;
    const who = resolve(text, url);
    if (!who) continue;
    const nextIdx = (i+1<all.length) ? all[i+1].idx : markdown.length;
    const block = markdown.slice(L.idx, Math.min(nextIdx, L.idx+900, markdown.length));
    const sku = extractSKU(L, block, who.brand, who.company, platform);
    if (sku) out.push(sku);
  }
  return out;
}

// Brand mode — keep only SKUs matching `brand` (unchanged Amazon behaviour).
function parseSKUsFromPage(markdown, pageUrl, brand, company){
  return parsePage(markdown, pageUrl, (text,url)=> brandMatches(brand,text,url) ? {brand,company} : null);
}
// Discover mode — classify every product (coverage searches).
function parseSKUsDiscover(markdown, pageUrl){
  return parsePage(markdown, pageUrl, (text,url)=> classifyBrand(text,url));
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

/* ---- Blinkit FREE-scrape probe (gated by DEBUG_BLINKIT) --------------------
   Honest test: can Firecrawl pull real products off Blinkit's search page?
   Dumps the raw response to data/_debug/blinkit/ and classifies the outcome —
   block / location-shell / products. Fabricates nothing; a 0 is a 0.        */
async function firecrawlScrape(url, key, body){
  let status = 0, json = null;
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method:'POST',
      headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ url, ...body }),
      signal: AbortSignal.timeout(150000),
    });
    status = res.status;
    json = await res.json().catch(()=>null);
  } catch(e){ json = { success:false, error:String((e && e.message) || e) }; }
  return { status, json };
}

// Retry on TRANSIENT Firecrawl failures only (5xx / proxy-tunnel/timeout) — not on real blocks.
async function firecrawlScrapeRetry(url, key, body, label){
  let res;
  for (let attempt=1; attempt<=3; attempt++){
    res = await firecrawlScrape(url, key, body);
    const err = (res.json && res.json.error) || '';
    const transient = res.status>=500 || /tunnel|proxy|timeout|temporarily|internal/i.test(err);
    if (!transient) break;
    console.log(`  [${label}] transient ${res.status} (${String(err).slice(0,70)}) — retry ${attempt}/3`);
    if (attempt<3) await new Promise(r=>setTimeout(r, 3000*attempt));
  }
  return res;
}

// Pure: decide what a q-commerce search page actually returned, from raw text + HTTP status.
function classifyQcomm(md, html, status){
  md = md || ''; html = html || '';
  const lc = (md + ' ' + html).toLowerCase();
  const priceHits = ((md + ' ' + html).match(/₹\s?\d|Rs\.?\s?\d/gi) || []).length;
  const blocked = status===403 || status===429 ||
    /captcha|access denied|forbidden|just a moment|attention required|cloudflare|unusual traffic/i.test(lc);
  const shell = !priceHits &&
    /(detecting your location|select.*location|enter.*(pincode|location|address)|set your location|not serviceable|choose.*location|provide your delivery location|download.*app)/i.test(lc);
  let outcome;
  if (blocked)             outcome = 'BLOCK (403/429/captcha/cloudflare)';
  else if (priceHits > 0)  outcome = `PRODUCTS (~${priceHits} ₹-price hits)`;
  else if (shell)          outcome = 'LOCATION SHELL (no products)';
  else if (md.length < 200 && html.length < 2000) outcome = 'EMPTY / near-blank';
  else                     outcome = 'NO PRODUCTS (no ₹, not an obvious shell — inspect dump)';
  return { outcome, priceHits, blocked, shell };
}

// Per-platform config for the free q-commerce scrape probe.
const QCOMM = {
  blinkit: { label:'Blinkit', urlFor: q => `https://blinkit.com/s/?q=${encodeURIComponent(q)}`,
    locationSelector:'[class*="LocationBar"], [class*="location"], [data-test-id*="location"], header [class*="Address"]' },
  zepto:   { label:'Zepto', urlFor: q => `https://www.zeptonow.com/search?query=${encodeURIComponent(q)}`,
    locationSelector:'[data-testid*="location" i], [data-testid*="address" i], [class*="location" i], [class*="Address" i], button[aria-label*="location" i]' },
  instamart:{ label:'Swiggy Instamart', urlFor: q => `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(q)}`,
    locationSelector:'[data-testid*="location" i], [data-testid*="address" i], [class*="location" i], [class*="Address" i], [aria-label*="location" i]' },
};

// Honest free-scrape probe for ONE q-commerce platform (same method that worked for Blinkit):
// JS render + a pincode actions attempt, fall back to plain render, dump raw to data/_debug/<platform>/.
async function probeQcomm(platform, key){
  const cfg = QCOMM[platform];
  if (!cfg){ console.error('unknown q-comm platform: '+platform); return; }
  const PINCODE = '110001';                                   // New Delhi metro
  const queries = ['Parle-G', 'Good Day biscuit'];
  const dir = `data/_debug/${platform}`;
  mkdirSync(dir, { recursive:true });
  const summary = [];

  for (const q of queries){
    const url = cfg.urlFor(q);
    // Attempt WITH actions: JS render, try to set a delivery pincode, screenshot, then capture.
    const withActions = {
      formats:['markdown','html'], onlyMainContent:false, waitFor:6000, timeout:120000,
      location:{ country:'IN', languages:['en-IN'] },
      actions:[
        { type:'wait', milliseconds:4000 },
        { type:'screenshot' },
        { type:'click', selector: cfg.locationSelector },
        { type:'wait', milliseconds:1200 },
        { type:'write', text: PINCODE },
        { type:'wait', milliseconds:1800 },
        { type:'press', key:'ENTER' },
        { type:'wait', milliseconds:4500 },
        { type:'screenshot' },
      ],
    };
    let res = await firecrawlScrapeRetry(url, key, withActions, platform);
    let usedActions = true;
    // If the actions request failed (e.g. selector not found), fall back to a plain JS render so we still get a dump.
    if (!(res.json && res.json.success)){
      console.log(`  [${platform}] "${q}" actions attempt failed (status ${res.status}${res.json && res.json.error ? ': '+res.json.error : ''}) — retrying plain JS render`);
      res = await firecrawlScrapeRetry(url, key, { formats:['markdown','html'], onlyMainContent:false, waitFor:9000, timeout:120000, location:{ country:'IN', languages:['en-IN'] } }, platform);
      usedActions = false;
    }

    const data = (res.json && res.json.data) || {};
    const md = data.markdown || '', html = data.html || '';
    const shots = (data.actions && data.actions.screenshots) || [];
    const cls = classifyQcomm(md, html, res.status);

    const slug = q.replace(/[^a-z0-9]+/gi,'_');
    writeFileSync(`${dir}/${slug}.summary.json`, JSON.stringify({
      platform, url, query:q, httpStatus:res.status, firecrawlSuccess: !!(res.json && res.json.success),
      firecrawlError: (res.json && res.json.error) || null, usedActions, outcome: cls.outcome,
      markdownBytes: md.length, htmlBytes: html.length, rupeePriceHits: cls.priceHits,
      screenshots: shots, sampleMarkdown: md.slice(0, 3000),
    }, null, 2));
    writeFileSync(`${dir}/${slug}.md`, md || '(empty markdown)');
    if (html) writeFileSync(`${dir}/${slug}.html`, html.slice(0, 200000));

    console.log(`  [${platform}] "${q}" → ${cls.outcome} | status ${res.status} | md ${md.length}b | html ${html.length}b | ₹hits ${cls.priceHits} | actions ${usedActions} | shots ${shots.length}`);
    summary.push({ query:q, outcome:cls.outcome, status:res.status, priceHits:cls.priceHits });
  }

  writeFileSync(`${dir}/RESULT.json`, JSON.stringify(
    { platform:cfg.label, testedAt:new Date().toISOString(), pincodeTried:PINCODE, results:summary }, null, 2));
  console.log(`  [${platform}] RESULT:`, JSON.stringify(summary));
}

async function main(){
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key){ console.error('FIRECRAWL_API_KEY not set'); process.exit(1); }

  // FREE TESTS (gated): probe one q-commerce platform only, then stop — no Amazon scrape, latest.json untouched.
  if (/^(1|true|yes|blinkit)$/i.test(process.env.DEBUG_BLINKIT || '')){
    console.log('DEBUG_BLINKIT set — running Blinkit probe ONLY (no Amazon scrape this run).');
    await probeQcomm('blinkit', key);
    return;
  }
  if (/^(1|true|yes|zepto)$/i.test(process.env.DEBUG_ZEPTO || '')){
    console.log('DEBUG_ZEPTO set — running Zepto probe ONLY (no Amazon scrape this run).');
    await probeQcomm('zepto', key);
    return;
  }
  if (/^(1|true|yes|instamart|swiggy)$/i.test(process.env.DEBUG_INSTAMART || '')){
    console.log('DEBUG_INSTAMART set — running Swiggy Instamart probe ONLY (no Amazon scrape this run).');
    await probeQcomm('instamart', key);
    return;
  }

  // Debug raw-markdown capture — OFF by default. Set DEBUG_DUMP_BRANDS to a
  // comma-separated brand list (via the Scrape workflow's debug_brands input) to
  // write those pages' raw Firecrawl markdown to data/_debug/ for parser work.
  // Reuses the normal scrape fetch, so it costs no extra Firecrawl calls.
  const DUMP_BRANDS = (process.env.DEBUG_DUMP_BRANDS||'').split(',').map(s=>s.trim()).filter(Boolean);

  // Tasks: tracked-brand searches (brand mode) + coverage searches (discover mode),
  // each run on BOTH channels — Amazon (e-comm) and BigBasket (quick-commerce).
  const tasks = [
    ...BRANDS.map(b => ({ label:b.brand, q:`${b.brand} biscuits`, mode:'brand', brand:b.brand, company:b.company })),
    ...COVERAGE.map(c => ({ label:c.label, q:c.q, mode:'discover' })),
  ];

  const allSkus = [], globalSeen = new Set();
  const channel = { Amazon:0, BigBasket:0 };
  const brandTrackedOk = new Set();

  for (const task of tasks){
    for (const [platform, build] of Object.entries(SEARCH)){
      const url = build(task.q);
      let md = '';
      try { md = await firecrawl(url, key); }
      catch(e){ console.log(`  ! ${task.label} / ${task.q} [${platform}]: ${e.message}`); continue; }

      if (DUMP_BRANDS.includes(task.label) || DUMP_BRANDS.includes(task.q)){
        mkdirSync('data/_debug', { recursive:true });
        writeFileSync(`data/_debug/${task.label.replace(/[^a-z0-9]+/gi,'_')}_${task.q.replace(/[^a-z0-9]+/gi,'_')}.${platform}.md`, md);
      }

      const parsed = task.mode==='brand'
        ? parseSKUsFromPage(md, url, task.brand, task.company)
        : parseSKUsDiscover(md, url);

      let added = 0;
      for (const s of parsed){
        const k = dedupeKey(s);
        if (globalSeen.has(k)) continue;
        globalSeen.add(k); allSkus.push(s); added++;
        channel[s.platform] = (channel[s.platform]||0) + 1;
        if (task.mode==='brand') brandTrackedOk.add(task.brand);
      }
      // honest per-channel logging — never fabricate a 0
      const note = (platform==='BigBasket' && added===0) ? (looksBlocked(md) ? ' (no products — pincode/bot wall)' : ' (no products parsed)') : '';
      console.log(`  ${task.label.padEnd(16)} ${task.q.padEnd(26)} [${platform.padEnd(9)}] ${added} SKUs${note}`);
    }
  }
  const brandsOk = brandTrackedOk.size;

  const scrapedAt = new Date().toISOString();
  mkdirSync('data', { recursive:true });
  writeFileSync('data/latest.json', JSON.stringify({ scrapedAt, skus: allSkus }, null, 2));

  // Compact per-run snapshot for the History view (summary metrics only — never
  // the full SKU list). Older/sparse entries are left as-is; the view tolerates them.
  const med = nums => { const a=nums.filter(v=>typeof v==='number').sort((x,y)=>x-y); if(!a.length) return 0; const n=a.length; return n%2 ? a[(n-1)/2] : (a[n/2-1]+a[n/2])/2; };
  const mean = nums => { const a=nums.filter(v=>v!=null); return a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0; };
  const medPpg = sub => +med(sub.map(s=>s.pricePerGram)).toFixed(3);
  const byCompany = {}; for (const co of new Set(allSkus.map(s=>s.company)))  byCompany[co]  = medPpg(allSkus.filter(s=>s.company===co));
  const byCategory = {}; for (const cat of new Set(allSkus.map(s=>s.category))) byCategory[cat] = medPpg(allSkus.filter(s=>s.category===cat));
  const ratings = allSkus.map(s=>s.rating).filter(v=>v!=null);
  const snapshot = {
    ts: scrapedAt,
    skuCount: allSkus.length,
    brandsOk,
    overall: {
      medianPpg: +med(allSkus.map(s=>s.pricePerGram)).toFixed(3),
      avgDiscount: +mean(allSkus.map(s=>s.discount)).toFixed(1),
      totalReviews: allSkus.reduce((a,s)=>a+(s.reviewCount||0),0),
      avgRating: ratings.length ? +mean(ratings).toFixed(1) : null,
    },
    byCompany,
    byCategory,
  };

  let history = [];
  try { if (existsSync('data/history.json')) history = JSON.parse(readFileSync('data/history.json','utf8')); } catch(_){}
  if (!Array.isArray(history)) history = [];
  history.push(snapshot);
  history = history.slice(-50);
  writeFileSync('data/history.json', JSON.stringify(history, null, 2));

  console.log(`\nTOTAL: ${allSkus.length} SKUs · ${brandsOk}/${BRANDS.length} tracked brands OK · channels: Amazon ${channel.Amazon||0}, BigBasket ${channel.BigBasket||0} · ${scrapedAt}`);
}

/* Run only when invoked directly (so tests can import the parser). */
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export {
  BRANDS, SEARCH, COVERAGE, ALIASES, EMERGING_BRANDS,
  parseWeightGrams, detectCategory, parseRating, parseReviewCount,
  extractPrices, cleanName, repairText, detectPlatform, parseSKUsFromPage, dedupeKey,
  parseSKUsDiscover, classifyBrand, looksBlocked, deriveBrand, classifyQcomm,
};
