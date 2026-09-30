// Can we intercept the browser's own audio requests (exact URLs+headers) and
// pull real bytes? This decides the whole delivery design.
import { chromium } from 'playwright-core';

const captured = [];
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

// Intercept audio and pull bytes through Node using the request's exact headers
await page.route(/googlevideo\.com\/videoplayback.*mime=audio/, async (route) => {
  const req = route.request();
  try {
    const resp = await route.fetch({ headers: { ...req.headers(), range: 'bytes=0-1048575' } });
    const buf = await resp.body();
    captured.push({ status: resp.status(), bytes: buf.length, url: req.url(), headers: req.headers() });
    await route.fulfill({ response: resp, body: buf });
  } catch (e) {
    captured.push({ error: String(e.message).slice(0, 90) });
    await route.continue();
  }
});

await page.goto('https://music.youtube.com/watch?v=NJAv_7lHUIU', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => { const v=document.querySelector('video'); if(v){v.muted=true; v.play?.().catch(()=>{});} });
  await page.waitForTimeout(2500);
}
const st = await page.evaluate(() => { const v=document.querySelector('video'); return { t: v?+v.currentTime.toFixed(1):null, d: v?+(v.duration||0).toFixed(1):null, err: v?.error?.code??null }; });
console.log('player state:', JSON.stringify(st));
console.log('intercepted audio requests:', captured.length);
captured.slice(0, 3).forEach((c, i) => console.log(` [${i}]`, JSON.stringify({ status: c.status, bytes: c.bytes, error: c.error, urlHasPot: c.url ? /[?&]pot=/.test(c.url) : null, itag: c.url ? (c.url.match(/[?&]itag=(\d+)/)||[])[1] : null })));
await browser.close();
