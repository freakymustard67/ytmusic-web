import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath:'/usr/bin/chromium', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport:{width:1280,height:860} })).newPage();
const errs=[]; page.on('console', m=>{ if(m.type()==='error') errs.push(m.text().slice(0,140)); });
page.on('pageerror', e=>errs.push('PAGEERROR '+e.message.slice(0,140)));

const t0=Date.now();
await page.goto('http://127.0.0.1:10000/', { waitUntil:'domcontentloaded', timeout:30000 });
console.log(`page loaded in ${Date.now()-t0}ms`);

await page.fill('#q', 'kesariya');
await page.press('#q', 'Enter');
await page.waitForSelector('.row', { timeout:60000 });
const rows = await page.locator('.row').count();
console.log('search rows rendered:', rows);
console.log('first row:', (await page.locator('.row .rowTitle').first().innerText()).slice(0,60));

await page.locator('.row').first().click();
// wait for the audio element to actually progress
const result = await page.evaluate(async () => {
  const a = document.getElementById('audio');
  const started = Date.now();
  while (Date.now() - started < 60000) {
    if (a.readyState >= 2 && a.currentTime > 0.5) break;
    await new Promise(r => setTimeout(r, 400));
  }
  return { src: a.currentSrc || a.src, readyState: a.readyState, currentTime: +a.currentTime.toFixed(2),
           duration: Number.isFinite(a.duration) ? +a.duration.toFixed(1) : null, paused: a.paused, error: a.error?.code ?? null };
});
console.log('AUDIO:', JSON.stringify(result));
console.log('nowPlaying:', await page.locator('#npTitle').innerText());
console.log('console errors:', errs.length ? errs.slice(0,3) : 'none');

// lyrics overlay
await page.click('#lyricsBtn');
await page.waitForTimeout(6000);
const ly = await page.locator('.lyricLine').count();
const src = await page.locator('#lyricsSource').innerText();
console.log(`lyrics: ${ly} lines | source="${src}"`);
console.log('first lyric:', ly ? (await page.locator('.lyricLine').first().innerText()).slice(0,50) : 'none');
await browser.close();
