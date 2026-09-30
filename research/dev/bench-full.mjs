// Final validation: capture one signed audio URL, download the WHOLE track via
// Node (replaying browser headers), and verify the file with ffprobe.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

let captured = null;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.route(/googlevideo\.com\/videoplayback.*mime=audio/, async (route) => {
  if (!captured) captured = { url: route.request().url(), headers: route.request().headers() };
  await route.continue();   // let the page play normally
});

await page.goto('https://music.youtube.com/watch?v=NJAv_7lHUIU', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
for (let i = 0; i < 4 && !captured; i++) {
  await page.evaluate(() => { const v=document.querySelector('video'); if(v){v.muted=true; v.play?.().catch(()=>{});} });
  await page.waitForTimeout(2500);
}
console.log('captured:', !!captured, '| itag', captured && (captured.url.match(/[?&]itag=(\d+)/)||[])[1], '| pot', captured && /[?&]pot=/.test(captured.url));
console.log('header names:', captured ? Object.keys(captured.headers).join(',') : 'none');
await browser.close();

if (!captured) process.exit(1);
// Download the entire track with the browser's exact headers
const t0 = Date.now();
const r = await fetch(captured.url, { headers: { ...captured.headers, range: 'bytes=0-' } });
console.log('full fetch status:', r.status, '| ct:', r.headers.get('content-type'), '| content-length:', r.headers.get('content-length'));
const buf = Buffer.from(await r.arrayBuffer());
const out = '/tmp/bench-track.m4a';
fs.writeFileSync(out, buf);
console.log(`wrote ${(buf.length/1048576).toFixed(2)} MB in ${((Date.now()-t0)/1000).toFixed(1)}s`);
