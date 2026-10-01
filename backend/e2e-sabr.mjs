import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath:'/usr/bin/chromium', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const page = await (await b.newContext({ viewport:{width:1280,height:820} })).newPage();
const errs=[]; page.on('pageerror', e=>errs.push(e.message.slice(0,120)));
page.on('console', m=>{ if(m.type()==='error') errs.push(m.text().slice(0,120)); });
await page.goto('http://127.0.0.1:10000/', { waitUntil:'domcontentloaded', timeout:30000 });
await page.fill('#q','kesariya'); await page.press('#q','Enter');
await page.waitForSelector('.row', { timeout:60000 });
console.log('rows:', await page.locator('.row').count(), '| first:', (await page.locator('.row .rowTitle').first().innerText()).slice(0,40));
await page.locator('.row').first().click();
const st = await page.evaluate(async () => {
  const a = document.getElementById('audio');
  const t0 = Date.now();
  while (Date.now()-t0 < 90000) { if (a.readyState>=2 && a.currentTime>0.5) break; await new Promise(r=>setTimeout(r,400)); }
  return { src:(a.currentSrc||a.src).slice(-40), rs:a.readyState, t:+a.currentTime.toFixed(2), d:Number.isFinite(a.duration)?+a.duration.toFixed(1):null, paused:a.paused, err:a.error?.code??null };
});
console.log('AUDIO:', JSON.stringify(st));
await page.click('#lyricsBtn'); await page.waitForTimeout(6000);
console.log('lyrics lines:', await page.locator('.lyricLine').count(), '| source:', await page.locator('#lyricsSource').innerText());
await page.screenshot({ path:'/home/freakymustard/ytmusic-web/docs/screenshot-player.png' });
await page.screenshot({ path:'/home/freakymustard/ytmusic-web/docs/screenshot-lyrics.png' });
console.log('console errors:', errs.length ? errs.slice(0,3) : 'none');
await b.close();
