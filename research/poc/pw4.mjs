import { chromium } from 'playwright-core';
import fs from 'node:fs';
const bgBundle = fs.readFileSync('bg.bundle.js', 'utf8');

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.route('**/*', async (route) => {
  const r = await route.fetch(); const h = { ...r.headers() };
  for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('content-security-policy') || k.toLowerCase()==='origin-agent-cluster') delete h[k];
  await route.fulfill({ response: r, headers: h });
});
await page.goto('https://music.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

const ch = await page.evaluate(async () => {
  const cfg = window.ytcfg; const client = cfg.get('INNERTUBE_CONTEXT').client;
  const r = await fetch(`/youtubei/v1/att/get?key=${cfg.get('INNERTUBE_API_KEY')}&prettyPrint=false`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ context:{ client:{ ...client, hl:'en', gl:'US' } }, engagementType:'ENGAGEMENT_TYPE_UNBOUND' })});
  const j = await r.json(); const bg = j.bgChallenge || j.bg_challenge;
  return { program: bg.program, globalName: bg.globalName||bg.global_name,
           interpreterUrl: bg.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue || bg.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value };
});
const iurl = ch.interpreterUrl.startsWith('http') ? ch.interpreterUrl : 'https:'+ch.interpreterUrl;
await page.addScriptTag({ content: await (await fetch(iurl, { headers:{referer:'https://music.youtube.com/'} })).text() });
await page.addScriptTag({ content: bgBundle });

const result = await page.evaluate(async ({ program, globalName }) => {
  const { BotGuardClient, WebPoMinter } = globalThis.__BG;
  const cfg = window.ytcfg; const client = cfg.get('INNERTUBE_CONTEXT').client;
  const apiKey = cfg.get('INNERTUBE_API_KEY');

  // mint a PoToken for THIS page's own visitorData
  const botguard = await BotGuardClient.create({ program, globalName, globalObject: window });
  const so = []; const bgResp = await botguard.snapshot({ webPoSignalOutput: so });
  const itr = await (await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
    method:'POST', headers:{'Content-Type':'application/json+protobuf','x-goog-api-key':'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw','x-user-agent':'grpc-web-javascript/0.1'},
    body: JSON.stringify(['o43z0dpjhgX20SCx4KAo', bgResp]) })).json();
  const minter = await WebPoMinter.create({ integrityToken: itr[0], estimatedTtlSecs: itr[1], mintRefreshThreshold: itr[2], websafeFallbackToken: itr[3] }, so);
  const poToken = await minter.mintAsWebsafeString(client.visitorData);

  // search for a song with the genuine WEB_REMIX context + token
  const ctxObj = { client: { ...client, hl:'en', gl:'US' } };
  const sr = await (await fetch(`/youtubei/v1/search?key=${apiKey}&prettyPrint=false`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ context: ctxObj, query:'kesariya', params:'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D' }) })).json();
  let videoId = null;
  try { videoId = sr.contents.tabbedSearchResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].musicResponsiveListItemRenderer.playlistItemData.videoId; } catch {}
  if (!videoId) return { stage:'search', err:'no videoId', keys:Object.keys(sr).slice(0,8) };

  // ask the player for stream URLs
  const pr = await (await fetch(`/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ context: ctxObj, videoId, contentCheckOk:true, racyCheckOk:true,
      playbackContext:{ contentPlaybackContext:{ signatureTimestamp: cfg.get('STS')||0 } },
      serviceIntegrityDimensions:{ poToken } }) })).json();
  const st = pr.streamingData;
  if (!st) return { stage:'player', status: pr.playabilityStatus?.status, reason: pr.playabilityStatus?.reason?.slice(0,160), videoId };
  const f = st.adaptiveFormats.filter(x => String(x.mimeType).startsWith('audio')).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0))[0];
  const url = f.url;
  // fetch the audio FROM THE PAGE (same IP, real referer)
  const rr = await fetch(url, { headers: { Range: 'bytes=0-32767' } });
  const ab = await rr.arrayBuffer();
  return { stage:'ok', status: pr.playabilityStatus?.status, videoId, itag:f.itag, urlHasPot:/[?&]pot=/.test(url),
           audioStatus: rr.status, bytes: ab.byteLength, magic: Array.from(new Uint8Array(ab).slice(0,12)).map(b=>b.toString(16).padStart(2,'0')).join('') };
}, { program: ch.program, globalName: ch.globalName });

console.log(JSON.stringify(result, null, 2));
await browser.close();
