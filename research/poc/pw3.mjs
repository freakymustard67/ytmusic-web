import { chromium } from 'playwright-core';
import fs from 'node:fs';

const bgBundle = fs.readFileSync('bg.bundle.js', 'utf8');
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();
await page.route('**/*', async (route) => {
  const r = await route.fetch();
  const h = { ...r.headers() };
  for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('content-security-policy') || k.toLowerCase() === 'origin-agent-cluster') delete h[k];
  await route.fulfill({ response: r, headers: h });
});
await page.goto('https://music.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

// Stage 1: challenge (same-origin, in page)
const ch = await page.evaluate(async () => {
  const cfg = window.ytcfg;
  const client = cfg.get('INNERTUBE_CONTEXT').client;
  const r = await fetch(`/youtubei/v1/att/get?key=${cfg.get('INNERTUBE_API_KEY')}&prettyPrint=false`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: { client: { ...client, hl: 'en', gl: 'US' } }, engagementType: 'ENGAGEMENT_TYPE_UNBOUND' }),
  });
  const j = await r.json();
  const bg = j.bgChallenge || j.bg_challenge;
  return { visitorData: client.visitorData, program: bg.program, globalName: bg.globalName || bg.global_name,
           interpreterUrl: bg.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue || bg.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value };
});

// Stage 2: interpreter fetched in Node, injected via Playwright
const url = ch.interpreterUrl.startsWith('http') ? ch.interpreterUrl : 'https:' + ch.interpreterUrl;
const code = await (await fetch(url, { headers: { referer: 'https://music.youtube.com/' } })).text();
await page.addScriptTag({ content: code });
await page.addScriptTag({ content: bgBundle });   // bgutils-js running IN the page

// Stage 3: full PoToken mint, entirely in the browser
const out = await page.evaluate(async ({ program, globalName, visitorData }) => {
  const { BotGuardClient, WebPoMinter } = globalThis.__BG;
  const botguard = await BotGuardClient.create({ program, globalName, globalObject: window });
  const webPoSignalOutput = [];
  const bgResp = await botguard.snapshot({ webPoSignalOutput });
  const itr = await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json+protobuf', 'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw', 'x-user-agent': 'grpc-web-javascript/0.1' },
    body: JSON.stringify(['o43z0dpjhgX20SCx4KAo', bgResp]),
  });
  const arr = await itr.json();
  let poToken = null, err = null;
  try {
    const minter = await WebPoMinter.create({ integrityToken: arr[0], estimatedTtlSecs: arr[1], mintRefreshThreshold: arr[2], websafeFallbackToken: arr[3] }, webPoSignalOutput);
    poToken = await minter.mintAsWebsafeString(visitorData);
  } catch (e) { err = String(e.message || e); }
  return { bgRespLen: bgResp?.length, signalOut: webPoSignalOutput.length, itrStatus: itr.status, poTokenLen: poToken?.length ?? 0, poToken, err };
}, { program: ch.program, globalName: ch.globalName, visitorData: ch.visitorData });

console.log(JSON.stringify({ ...out, poToken: out.poToken ? out.poToken.slice(0, 32) + '…' : null }, null, 2));
if (out.poToken) fs.writeFileSync('/tmp/ytm-poc/pot.json', JSON.stringify({ poToken: out.poToken, visitorData: ch.visitorData }));
await browser.close();
