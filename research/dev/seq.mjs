// Does requesting successive ranges from the negotiated URL yield the whole track?
import { chromium } from 'playwright-core';
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
if (!captured) { console.log('no url captured'); process.exit(1); }
console.log('itag', (captured.url.match(/[?&]itag=(\d+)/)||[])[1], '| headers:', Object.keys(captured.headers).length);

const EBML = Buffer.from([0x1a,0x45,0xdf,0xa3]);
const parts = []; let total = 0;
let r = await fetch(captured.url, { headers: captured.headers });   // first chunk: no range
for (let i=0;i<200;i++){
  const b = Buffer.from(await r.arrayBuffer());
  const at = b.indexOf(EBML);
  const media = at >= 0 ? b.subarray(at) : b;
  if (media.length) { parts.push(media); total += media.length; }
  const cr = r.headers.get('content-range');
  console.log(`#${i} http=${r.status} recv=${b.length} media=${media.length} cr=${cr} total=${(total/1048576).toFixed(2)}MB`);
  if (i >= 2 && total > 0) break;  // 3 samples is enough to prove progression
  const m = cr && cr.match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
  if (!m) break;
  const next = parseInt(m[2],10)+1;
  const len = parseInt(m[1],10) || 65536;
  r = await fetch(captured.url, { headers: { ...captured.headers, range: `bytes=${next}-${next+len-1}` } });
}
