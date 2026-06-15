/**
 * scripts/debug-dump.mjs — TEMPORARY (Step 2 parser fix).
 * Dumps raw Firecrawl markdown for a few brand/platform pages to data/_debug/
 * so the parser can be reworked against real markdown. Delete after use.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const key = process.env.FIRECRAWL_API_KEY;
if (!key) { console.error('FIRECRAWL_API_KEY not set'); process.exit(1); }

const targets = [
  ['Parle-G',  'Amazon',    'https://www.amazon.in/s?k=' + encodeURIComponent('Parle-G biscuits')],
  ['Good_Day', 'Amazon',    'https://www.amazon.in/s?k=' + encodeURIComponent('Good Day biscuits')],
  ['Bourbon',  'Amazon',    'https://www.amazon.in/s?k=' + encodeURIComponent('Bourbon biscuits')],
  ['Parle-G',  'BigBasket', 'https://www.bigbasket.com/ps/?q=' + encodeURIComponent('Parle-G biscuits')],
];

mkdirSync('data/_debug', { recursive: true });

for (const [brand, plat, url] of targets) {
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: false }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    const md = (data.data && data.data.markdown) || `ERROR ${res.status}: ${JSON.stringify(data).slice(0, 300)}`;
    const f = `data/_debug/${brand}.${plat}.md`;
    writeFileSync(f, md);
    console.log('wrote', f, md.length, 'chars');
  } catch (e) {
    console.log('fail', brand, plat, e.message);
  }
}
