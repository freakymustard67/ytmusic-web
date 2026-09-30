import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required','--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const media = [];   // googlevideo audio responses
page.on('response', async (r) => {
  const u = r.url();
  if (!/googlevideo\.com\/videoplayback/.test(u)) return;
  const isAudioOnly = /mime=audio/.test(u);
  media.push({ status: r.status(), audio: isAudioOnly, pot: /[?&]pot=/.test(u), itag: (u.match(/[?&]itag=(\d+)/)||[])[1], host: new URL(u).host.slice(0,22) });
});

await page.goto('https://music.youtube.com/watch?v=NJAv_7lHUIU', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);
// nudge playback
await page.evaluate(() => {
  const v = document.querySelector('video');
  if (v) { v.muted = true; v.play?.().catch(()=>{}); }
  document.querySelector('#play-pause-button')?.click?.();
});
await page.waitForTimeout(12000);
await page.evaluate(() => { const v=document.querySelector('video'); if(v){v.muted=true; v.play?.().catch(()=>{});} });
await page.waitForTimeout(9000);

const state = await page.evaluate(() => {
  const v = document.querySelector('video');
  return { title: document.title.slice(0,70), hasVideo: !!v,
           currentTime: v ? +v.currentTime.toFixed(2) : null, duration: v ? +(v.duration||0).toFixed(1) : null,
           readyState: v?.readyState, networkState: v?.networkState, error: v?.error?.code ?? null,
           paused: v?.paused };
});
console.log('PAGE STATE:', JSON.stringify(state, null, 2));
console.log('MEDIA REQUESTS:', media.length);
for (const m of media.slice(0, 8)) console.log('  ', JSON.stringify(m));
const ok = media.filter(m => m.status === 200);
console.log(`=> googlevideo 200s: ${ok.length} | 403s: ${media.filter(m=>m.status===403).length}`);
await browser.close();
