// Decide the audio path: can the browser session serve byte ranges on demand?
import { chromium } from 'playwright-core';
import { Innertube, Platform } from 'youtubei.js';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
const { window: w } = dom;
Platform.shim.eval = (data, env) => {
  const holder = { exportedVars: { nsigFunction: undefined }, ...env };
  const sandbox = new Proxy(holder, { has: () => true, get: (t,k) => (k in t ? t[k] : (k==='globalThis'?sandbox:(k in w ? w[k] : undefined))) });
  vm.createContext(sandbox);
  try { new vm.Script(`(function(){ ${data.output} })()`).runInContext(sandbox); } catch {}
  for (const k of (data.exported ?? [])) if (k in holder) holder.exportedVars[k] = holder[k];
  const o = {}; for (const k of ['n','sig']) if (holder[k] !== undefined) o[k] = holder[k];
  return o;
};

// 1. Get a deciphered googlevideo URL in Node (cheap, no browser)
const yt = await Innertube.create({ retrieve_player: true });
const s = await yt.music.search('kesariya', { type: 'song' });
const track = s.songs.contents[0];
const info = await yt.music.getInfo(track.id);
const fmt = info.chooseFormat({ type: 'audio', quality: 'best' });
const url = fmt.url ?? await fmt.decipher(yt.session.player);
console.log('resolved URL host:', new URL(url).host, '| itag', fmt.itag, '| len', fmt.content_length);

// 2. Open the browser with a passing IP session and fetch ranges FROM the page
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://music.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

const r = await page.evaluate(async ({ url }) => {
  const attempts = {};
  for (const [label, headers] of Object.entries({
    none: {},
    range: { Range: 'bytes=0-32767' },
  })) {
    try {
      const res = await fetch(url, { headers });
      const b = await res.arrayBuffer();
      attempts[label] = { status: res.status, bytes: b.byteLength, ct: res.headers.get('content-type') };
    } catch (e) { attempts[label] = { error: String(e.message) }; }
  }
  return attempts;
}, { url });
console.log('IN-PAGE fetch results:', JSON.stringify(r, null, 2));
await browser.close();
