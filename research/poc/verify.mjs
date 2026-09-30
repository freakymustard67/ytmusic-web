import { Innertube, Platform } from 'youtubei.js';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const { poToken, visitorData } = JSON.parse(fs.readFileSync('/tmp/ytm-poc/pot.json', 'utf8'));
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

async function pull(label, opts) {
  const yt = await Innertube.create({ retrieve_player: true, ...opts });
  const s = await yt.music.search('kesariya', { type: 'song' });
  const t = s.songs.contents[0];
  const info = await yt.music.getInfo(t.id);
  const fmt = info.chooseFormat({ type: 'audio', quality: 'best' });
  const url = fmt.url ?? await fmt.decipher(yt.session.player);
  const r = await fetch(url, { headers: { Range: 'bytes=0-32767' } });
  const buf = Buffer.from(await r.arrayBuffer());
  console.log(`${label}: HTTP ${r.status} | ${r.headers.get('content-type')} | ${buf.length}B | pot=${/[?&]pot=/.test(url)}`);
  if (r.status === 200) console.log(`   magic=${buf.subarray(0,12).toString('hex')}  (ftyp/mp4 if it starts with 000000..66747970)`);
  return r.status;
}
await pull('NO token  ', {});
await pull('WITH POtoken', { po_token: poToken, visitor_data: visitorData });
