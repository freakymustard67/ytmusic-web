import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath:'/usr/bin/chromium', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const page = await (await b.newContext({ viewport:{width:1280,height:820}, deviceScaleFactor:1 })).newPage();
await page.goto('http://127.0.0.1:10000/', { waitUntil:'domcontentloaded' });
await page.fill('#q','kesariya');
await page.press('#q','Enter');
await page.waitForSelector('.row',{timeout:60000});
await page.locator('.row').first().click();
// wait until actually playing
await page.waitForFunction(() => { const a=document.getElementById('audio'); return a && a.readyState>=2 && a.currentTime>1; }, { timeout:90000 }).catch(()=>{});
await page.waitForTimeout(2500);
await page.screenshot({ path:'/home/freakymustard/ytmusic-web/docs/screenshot-player.png' });
// lyrics view, scrolled to the active line
await page.click('#lyricsBtn');
await page.waitForSelector('.lyricLine',{timeout:30000}).catch(()=>{});
await page.waitForTimeout(3500);
await page.screenshot({ path:'/home/freakymustard/ytmusic-web/docs/screenshot-lyrics.png' });
const st = await page.evaluate(()=>{ const a=document.getElementById('audio'); return { t:+a.currentTime.toFixed(1), d:+(a.duration||0).toFixed(1), paused:a.paused }; });
console.log('playing state at screenshot:', JSON.stringify(st));
await b.close();
