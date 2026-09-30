import { Innertube, Platform } from 'youtubei.js';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

// jsdom used BOTH as the decipher VM host and the BotGuard host
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window; globalThis.document = window.document;

Platform.shim.eval = (data, env) => {
  const holder = { exportedVars: { nsigFunction: undefined }, ...env };
  const sandbox = new Proxy(holder, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : (k in window ? window[k] : undefined)),
  });
  vm.createContext(sandbox);
  try { new vm.Script(`(function(){ ${data.output} })()`).runInContext(sandbox); }
  catch (e) { console.log('   [eval warn]', e.message.split('\n')[0]); }
  for (const k of (data.exported ?? [])) if (k in holder) holder.exportedVars[k] = holder[k];
  const out = {};
  for (const k of ['n', 'sig']) if (holder[k] !== undefined) out[k] = holder[k];
  return out;
};

const REQUEST_KEY = "o43z0dpjhgX20SCx4KAo";
const yt = await Innertube.create({ retrieve_player: true });
console.log("probe:", typeof yt?.music, "| yt keys:", yt ? Object.keys(yt).length : "null");

async function tryPlay(tag, inst) {
  const s = await inst.music.search('kesariya', { type: 'song' });
  const info = await inst.music.getInfo(s.songs.contents[0].id);
  const fmt = info.chooseFormat({ type: 'audio', quality: 'best' });
  const url = fmt.url ?? await fmt.decipher(inst.session.player);
  const r = await fetch(url, { headers: { Range: 'bytes=0-16383' } });
  const buf = Buffer.from(await r.arrayBuffer());
  console.log(`${tag}: HTTP ${r.status} | ${r.headers.get('content-type')} | ${buf.length}B | pot=${/[?&]pot=/.test(url)}`);
  return r.status;
}
await tryPlay('WITHOUT pot');

// mint a PoToken through BotGuard
const ch = await yt.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');
const bg = ch.bg_challenge;
const js = await (await fetch(`https:${bg.interpreter_url.private_do_not_access_or_else_trusted_resource_url_wrapped_value}`)).text();
const sc = window.document.createElement('script');
sc.textContent = js;
window.document.head.appendChild(sc);

const botguard = await BotGuardClient.create({ program: bg.program, globalName: bg.global_name, globalObject: window });
const webPoSignalOutput = [];
const bgResp = await botguard.snapshot({ webPoSignalOutput });
const itr = await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json+protobuf',
    'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
    'x-user-agent': 'grpc-web-javascript/0.1',
  },
  body: JSON.stringify([REQUEST_KEY, bgResp]),
});
const arr = await itr.json();
console.log('GenerateIT:', itr.status, '| array?', Array.isArray(arr));
if (!Array.isArray(arr)) { console.log(JSON.stringify(arr).slice(0, 300)); process.exit(1); }
const [integrityToken, ttl, refresh, fallback] = arr;
const minter = await WebPoMinter.create({ integrityToken, estimatedTtlSecs: ttl, mintRefreshThreshold: refresh, websafeFallbackToken: fallback }, webPoSignalOutput);
const visitorData = yt.session.context.client.visitorData;
const poToken = await minter.mintAsWebsafeString(visitorData);
console.log('PO TOKEN minted, len:', poToken?.length);

const yt2 = await Innertube.create({ retrieve_player: true, po_token: poToken, visitor_data: visitorData });
await tryPlay('WITH pot   ');
