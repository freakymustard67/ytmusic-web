// Do concatenated MSE audio segments form a playable file? (settles both
// streaming and the download/offline feature)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const segs = [];
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

await page.route(/googlevideo\.com\/videoplayback.*mime=audio/, async (route) => {
  const req = route.request();
  const rng = req.headers()['range'];
  try {
    const resp = await route.fetch();
    const body = await resp.body();
    // keep every distinct byte range
    segs.push({ range: rng || '(none)', bytes: body.length, body });
    await route.fulfill({ response: resp, body });
  } catch { await route.continue(); }
});

await page.goto('https://music.youtube.com/watch?v=NJAv_7lHUIU', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
// let it buffer generously, then seek around to force more segments
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => { const v=document.querySelector('video'); if(v){v.muted=true; v.play?.().catch(()=>{});} });
  await page.waitForTimeout(2500);
}
await page.evaluate(() => { const v=document.querySelector('video'); if(v) v.currentTime = 90; });
await page.waitForTimeout(6000);
const st = await page.evaluate(() => { const v=document.querySelector('video'); return { t:v?+v.currentTime.toFixed(1):null, d:v?+(v.duration||0).toFixed(1):null, buffered: v&&v.buffered.length?[+v.buffered.start(0).toFixed(1),+v.buffered.end(v.buffered.length-1).toFixed(1)]:null }; });
await browser.close();

console.log('player:', JSON.stringify(st));
console.log('segments captured:', segs.length);
console.log('total bytes:', (segs.reduce((a,s)=>a+s.bytes,0)/1048576).toFixed(2), 'MB');
const ranges = segs.map(s=>s.range).filter(r=>r!=='(none)');
const uniq = [...new Set(ranges)];
console.log('distinct ranges:', uniq.length ? uniq.slice(0,4).join(' | ') : '(none - full-file 200s)');
// concatenate in arrival order and see if it parses
const all = Buffer.concat(segs.map(s=>s.body));
fs.writeFileSync('/tmp/seg-concat.bin', all);
fs.writeFileSync('/tmp/seg-list.json', JSON.stringify(segs.map(x=>x.bytes)));
console.log('concat size:', (all.length/1048576).toFixed(2), 'MB; first bytes:', all.subarray(0,16).toString('hex'));
