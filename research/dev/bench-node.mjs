// Benchmark: can plain Node fetch googlevideo bytes once a browser has minted
// a session-matched PoToken and we replay browser-ish headers?
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const bgBundle = fs.readFileSync(new URL('./bg.bundle.js', import.meta.url), 'utf8');

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.route('**/*', async (route) => {
  const r = await route.fetch(); const h = { ...r.headers() };
  for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('content-security-policy') || k.toLowerCase()==='origin-agent-cluster') delete h[k];
  await route.fulfill({ response: r, headers: h });
});
// Warm the session on a watch page so /player has proper context (this is what made pw5 succeed)
await page.goto('https://music.youtube.com/watch?v=NJAv_7lHUIU', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
await page.evaluate(() => { const v=document.querySelector('video'); if(v){v.muted=true; v.play?.().catch(()=>{});} });
await page.waitForTimeout(3000);

const ch = await page.evaluate(async () => {
  const cfg = window.ytcfg; const client = cfg.get('INNERTUBE_CONTEXT').client;
  const r = await fetch(`/youtubei/v1/att/get?key=${cfg.get('INNERTUBE_API_KEY')}&prettyPrint=false`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ context:{ client:{ ...client, hl:'en', gl:'US' } }, engagementType:'ENGAGEMENT_TYPE_UNBOUND' })});
  const j = await r.json(); const bg = j.bgChallenge || j.bg_challenge;
  return { program: bg.program, globalName: bg.globalName||bg.global_name,
    interpreterUrl: bg.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue || bg.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value,
    visitorData: client.visitorData, clientVersion: client.clientVersion };
});
const iurl = ch.interpreterUrl.startsWith('http') ? ch.interpreterUrl : 'https:'+ch.interpreterUrl;
await page.addScriptTag({ content: await (await fetch(iurl, { headers:{referer:'https://music.youtube.com/'} })).text() });
await page.addScriptTag({ content: bgBundle });

// Play the song in the real page, then read the audio URL the player itself uses.
await page.evaluate(() => { const v=document.querySelector('video'); if(v){v.muted=true; v.play?.().catch(()=>{});} });
await page.waitForTimeout(8000);
const got = await page.evaluate(() => {
  const v = document.querySelector('video');
  const url = v?.currentSrc || v?.src || null;
  return { url, currentTime: v ? +v.currentTime.toFixed(2) : null, duration: v ? +(v.duration||0).toFixed(1) : null, err: v?.error?.code ?? null };
});
console.log('element state: t=', got.currentTime, '/', got.duration, 'err=', got.err);
console.log('captured URL: pot=', /[?&]pot=/.test(got.url||''), '| len', (got.url||'').length, '| host', got.url ? new URL(got.url).host : 'none');
fs.writeFileSync('/tmp/bench.json', JSON.stringify(got));
await browser.close();

// ---- Now try to fetch those same bytes from plain Node ----
const variants = {
  'bare':                    {},
  'UA only':                 { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' },
  'UA+referer+origin':       { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
                               referer: 'https://music.youtube.com/', origin: 'https://music.youtube.com' },
  'UA+ref+origin+fetchmeta': { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
                               referer: 'https://music.youtube.com/', origin: 'https://music.youtube.com',
                               'sec-fetch-dest':'empty','sec-fetch-mode':'cors','sec-fetch-site':'cross-site',
                               'accept':'*/*','accept-language':'en-US,en;q=0.9','range':'bytes=0-32767' },
};
for (const [name, headers] of Object.entries(variants)) {
  try {
    const r = await fetch(got.url, { headers });
    const ab = await r.arrayBuffer();
    console.log(`node fetch [${name}]: HTTP ${r.status} | ${ab.byteLength}B | ${r.headers.get('content-type')}`);
  } catch (e) { console.log(`node fetch [${name}]: ERROR ${e.message}`); }
}
