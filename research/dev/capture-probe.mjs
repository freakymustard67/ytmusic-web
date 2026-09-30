import { chromium } from 'playwright-core';
const videoId='NJAv_7lHUIU';
const segs=[]; let reqs=0;
const browser = await chromium.launch({ executablePath:'/usr/bin/chromium', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', viewport:{width:1280,height:800} });
const page = await ctx.newPage();
await page.route(/googlevideo\.com\/videoplayback.*mime=audio/, async (route)=>{
  reqs++;
  try { const r = await route.fetch(); const b = Buffer.from(await r.body());
    const i = b.indexOf(Buffer.from([0x1a,0x45,0xdf,0xa3]));
    segs.push(i>=0? b.subarray(i) : b.subarray(Math.max(0,b.indexOf(Buffer.from('ftyp'))-4)));
    await route.fulfill({ response:r, body:b });
  } catch { await route.continue(); }
});
await page.goto(`https://music.youtube.com/watch?v=${videoId}`, { waitUntil:'domcontentloaded', timeout:60000 });
const start=Date.now();
for (let i=0;i<40;i++){
  const st = await page.evaluate(()=>{ const v=document.querySelector('video'); if(!v) return null;
    v.muted=true; v.play?.().catch(()=>{}); return {t:+v.currentTime.toFixed(1),d:+(v.duration||0).toFixed(1)}; });
  if (i%5===0) console.log(`t=${st?.t}/${st?.d} reqs=${reqs} segs=${segs.length} bytes=${(segs.reduce((a,b)=>a+b.length,0)/1048576).toFixed(2)}MB`);
  if (st && st.d && st.t>=st.d-1) { console.log('reached end'); break; }
  await page.waitForTimeout(700);
}
console.log(`FINAL: reqs=${reqs} segs=${segs.length} bytes=${(segs.reduce((a,b)=>a+b.length,0)/1048576).toFixed(2)}MB in ${((Date.now()-start)/1000).toFixed(0)}s`);
import fs from 'node:fs'; fs.writeFileSync('/tmp/cap.webm', Buffer.concat(segs));
await browser.close();
