import { chromium } from 'playwright-core';
import fs from 'node:fs';
const videoId = 'NJAv_7lHUIU';
let captured = null;
const browser = await chromium.launch({ executablePath:'/usr/bin/chromium', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.route(/googlevideo\.com\/videoplayback.*mime=audio/, async (route)=>{
  if (!captured) captured = { url: route.request().url(), headers: route.request().headers() };
  await route.continue();
});
await page.goto(`https://music.youtube.com/watch?v=${videoId}`, { waitUntil:'domcontentloaded', timeout:60000 });
for (let i=0;i<25 && !captured;i++){ await page.evaluate(()=>{const v=document.querySelector('video'); if(v){v.muted=true;v.play?.().catch(()=>{});} }); await page.waitForTimeout(1000); }
await browser.close();
const clen = Number((captured.url.match(/[?&]clen=(\d+)/)||[])[1] || 0);
console.log('itag', (captured.url.match(/[?&]itag=(\d+)/)||[])[1], '| clen =', clen, `(${(clen/1048576).toFixed(2)} MB)`);

const EBML = Buffer.from([0x1a,0x45,0xdf,0xa3]);
const parts = []; let total = 0; let empty = 0;
const t0 = Date.now();
for (let i=0; i<4000 && empty < 5; i++){
  const r = await fetch(captured.url, { headers: captured.headers });
  if (!r.ok) { console.log('http', r.status, '-> stop'); break; }
  const b = Buffer.from(await r.arrayBuffer());
  const at = b.indexOf(EBML);
  const media = at >= 0 ? b.subarray(at) : (b.indexOf(Buffer.from('ftyp')) >= 4 ? b.subarray(b.indexOf(Buffer.from('ftyp'))-4) : b);
  if (!media.length) { empty++; continue; }
  empty = 0;
  parts.push(media); total += media.length;
  if (i % 20 === 0) console.log(`  #${i} total=${(total/1048576).toFixed(2)}MB ${clen?`(${((total/clen)*100).toFixed(0)}%)`:''} ${((Date.now()-t0)/1000).toFixed(0)}s`);
  if (clen && total >= clen) { console.log('reached clen'); break; }
}
const out = Buffer.concat(parts);
fs.writeFileSync('/tmp/seq2.webm', out);
console.log(`DONE: ${(out.length/1048576).toFixed(2)} MB in ${((Date.now()-t0)/1000).toFixed(1)}s (clen target ${(clen/1048576).toFixed(2)} MB)`);
