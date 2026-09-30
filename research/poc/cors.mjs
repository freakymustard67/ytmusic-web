import { Innertube, Platform } from 'youtubei.js';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
const { window } = dom;
Platform.shim.eval = (data, env) => {
  const holder = { exportedVars: { nsigFunction: undefined }, ...env };
  const sandbox = new Proxy(holder, { has: () => true, get: (t,k) => (k in t ? t[k] : (k === 'globalThis' ? sandbox : (k in window ? window[k] : undefined))) });
  vm.createContext(sandbox);
  try { new vm.Script(`(function(){ ${data.output} })()`).runInContext(sandbox); } catch {}
  for (const k of (data.exported ?? [])) if (k in holder) holder.exportedVars[k] = holder[k];
  const out = {}; for (const k of ['n','sig']) if (holder[k] !== undefined) out[k] = holder[k];
  return out;
};

const yt = await Innertube.create({ retrieve_player: true });
const s = await yt.music.search('kesariya', { type: 'song' });
const t = s.songs.contents[0];
const info = await yt.music.getInfo(t.id);
const fmt = info.chooseFormat({ type: 'audio', quality: 'best' });
const url = fmt.url ?? await fmt.decipher(yt.session.player);

console.log('=== 1. Does googlevideo send CORS headers? (GET with Origin) ===');
const g = await fetch(url, { headers: { Origin: 'https://example.com', Range: 'bytes=0-1023' } });
for (const h of ['access-control-allow-origin','access-control-expose-headers','timing-allow-origin','content-range','content-type','vary']) {
  console.log(`  ${h}: ${g.headers.get(h) ?? '(absent)'}`);
}
console.log('  status:', g.status);

console.log('=== 2. Preflight OPTIONS ===');
const o = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } });
console.log('  status:', o.status);
for (const h of ['access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','access-control-max-age']) {
  console.log(`  ${h}: ${o.headers.get(h) ?? '(absent)'}`);
}

console.log('=== 3. Metadata-only endpoints (the parts Render WOULD serve) ===');
console.log('  InnerTube API (music.youtube.com/youtubei) is a same-origin-limited POST; browser cannot call it cross-origin without ACAO.');
const ytApi = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' } });
console.log('  OPTIONS /youtubei/v1/search ->', ytApi.status, '| ACAO:', ytApi.headers.get('access-control-allow-origin') ?? '(absent)');
