// One-off generator for the SEEDED data/trends.json (Google-Trends-shaped).
// Deterministic so the committed file is stable. Real CSV can replace it later.
import { writeFileSync } from 'node:fs';

// [target latest interest (0-100), monthly slope] — well-known brands high, D2C/niche low.
const BRANDS = {
  "Good Day":[70,0.2], "Bourbon":[58,0.1], "Marie Gold":[52,-1.0], "NutriChoice":[34,1.1],
  "Parle-G":[92,0.1], "Monaco":[48,-0.2], "Hide & Seek":[55,1.0], "KrackJack":[30,-0.1],
  "Dark Fantasy":[62,1.3], "Mom's Magic":[40,0.3], "Sunfeast Marie Light":[28,-0.9],
  "Oreo":[78,1.2], "Unibic":[26,0.2], "The Whole Truth":[18,1.4],
};
const CATEGORIES = {
  "Cookies":[80,0.9], "Digestive":[55,1.2], "Cream":[65,0.1],
  "Crackers":[40,-0.1], "Rusk":[35,0.0], "Wafer":[45,0.8],
};

// deterministic PRNG (mulberry32)
function rng(seed){ return ()=>{ seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

function build(map, seed0){
  const out = {}; let seed = seed0;
  for (const [name,[base,slope]] of Object.entries(map)){
    const rand = rng(seed += 7919);
    const interest = [];
    for (let i=0;i<12;i++){
      const noise = (rand()-0.5)*8;
      interest.push(Math.max(1, Math.min(100, Math.round(base + slope*(i-11) + noise))));
    }
    const first3 = (interest[0]+interest[1]+interest[2])/3;
    const last3  = (interest[9]+interest[10]+interest[11])/3;
    const diff = last3 - first3;
    const direction = diff >= 4 ? "rising" : diff <= -4 ? "falling" : "flat";
    out[name] = { interest, latest: interest[11], direction };
  }
  return out;
}

const trends = {
  source: "Google Trends (seeded snapshot — update from trends.google.com)",
  geo: "IN",
  updated: new Date().toISOString().slice(0,10),
  timeframe: "last 12 months",
  note: "Relative search interest (0–100), NOT sales. Seeded placeholder values — replace with a real Google Trends CSV export (same shape) when available.",
  brands: build(BRANDS, 1000),
  categories: build(CATEGORIES, 5000),
};

writeFileSync('data/trends.json', JSON.stringify(trends, null, 2));
console.log('wrote data/trends.json — brands:', Object.keys(trends.brands).length, '· categories:', Object.keys(trends.categories).length);
for (const [b,v] of Object.entries(trends.brands)) console.log('  '+b.padEnd(22), 'latest', String(v.latest).padStart(3), v.direction);
