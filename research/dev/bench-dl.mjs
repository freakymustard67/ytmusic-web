// Validate: capture the googlevideo audio URL the BROWSER actually uses,
// then download the whole track in-page and report size (informs cache design).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const audioUrls = new Map();
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('request', (r) => {
  const u = r.url();
  if (/googlevideo\.com\/videoplayback/.test(u) && /mime=audio/.test(u)) audioUrls.set(u.split('&range=')[0], { itag: (u.match(/[?&]itag=(\d+)/)||[])[1] });
});

await page.goto('https://music.youtube.com/watch?v=NJAv_7lHUIU', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => { const v=document.querySelector('video'); if(v){v.muted=true; v.play?.().catch(()=>{});} });
  await page.waitForTimeout(3000);
}
console.log('distinct audio URLs seen:', audioUrls.size);
const first = [...audioUrls.keys()].find(u => /[?&]pot=/.test(u)) || [...audioUrls.keys()][0];
console.log('using url: itag', (first.match(/[?&]itag=(\d+)/)||[])[1], '| pot=', /[?&]pot=/.test(first), '| clen=', (first.match(/[?&]clen=(\d+)/)||[])[1]);

// Download the FULL audio track inside the page (streamed, measured)
const t0 = Date.now();
const res = await page.evaluate(async ({ url }) => {
  const r = await fetch(url);
  if (!r.ok) return { status: r.status, bytes: 0 };
  const reader = r.body.getReader();
  let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; }
  return { status: r.status, bytes: total, ct: r.headers.get('content-type') };
}, { url: first });
console.log('full download:', JSON.stringify(res), `in ${((Date.now()-t0)/1000).toFixed(1)}s`);
await browser.close();
