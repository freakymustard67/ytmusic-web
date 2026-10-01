// Server-side SABR audio download — no browser rendering, no page player.
import { Innertube, Platform, Log, YTNodes, Constants } from 'youtubei.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat } from 'googlevideo/utils';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM } from 'jsdom';
import { parseLooseJSON } from 'bgutils-js/utils';
import fs from 'node:fs';
Log.setLevel(Log.Level.NONE);

const VIDEO = process.argv[2] || 'NJAv_7lHUIU';
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';           // uppercase O, per LuanRT's example
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/* ---------- 1. BotGuard PoToken from the YouTube HTML challenge (no browser) ---------- */
const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
  url: 'https://www.youtube.com', referrer: 'https://www.youtube.com/', userAgent: UA,
});
const pageHtml = await (await fetch('https://www.youtube.com', {
  headers: { accept: '*/*', 'accept-language': 'en-US,en;q=0.7', 'user-agent': UA },
})).text();
const ytcfgRaw = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
if (!ytcfgRaw) throw new Error('no ytcfg in page HTML');
dom.window.yt = { config_: JSON.parse(ytcfgRaw) };
dom.window.HTMLCanvasElement.prototype.getContext = function (id) {
  if (id !== '2d') return null;
  const noop = () => {};
  return { fillRect:noop, clearRect:noop, getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
    putImageData:noop, createImageData:()=>[], setTransform:noop, drawImage:noop, save:noop, fillText:noop,
    restore:noop, beginPath:noop, moveTo:noop, lineTo:noop, closePath:noop, stroke:noop, translate:noop,
    scale:noop, rotate:noop, arc:noop, fill:noop, measureText:()=>({width:0}), transform:noop, rect:noop, clip:noop };
};
Object.assign(globalThis, { yt: dom.window.yt, window: dom.window, document: dom.window.document,
  location: dom.window.location, origin: dom.window.origin });
if (!('navigator' in globalThis)) Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const attMatch = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
if (!attMatch) throw new Error('no ytAtN challenge in page HTML');
const attObj = parseLooseJSON(attMatch[1]);
// The attestation payload sits under `.R`; accept a couple of shapes.
const challenge =
  attObj?.R?.bgChallenge ??
  attObj?.bgChallenge ??
  attObj?.R?.challenge?.bgChallenge ??
  null;
if (!challenge?.program) {
  throw new Error('challenge missing; top-level keys: ' + Object.keys(attObj || {}).join(','));
}
const program = challenge.program;
const globalName = challenge.globalName || challenge.global_name;
const interpreterWrapped =
  challenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue ??
  challenge.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
if (!interpreterWrapped) throw new Error('no interpreterUrl in challenge');
const interpreterJs = await (await fetch(
  interpreterWrapped.startsWith('http') ? interpreterWrapped : 'https:' + interpreterWrapped,
)).text();
new Function(interpreterJs)();
console.log('challenge ok | program', program.length, '| globalName', globalName);

const botguard = await BotGuardClient.create({ program, globalName, globalObject: globalThis });
const webPoSignalOutput = [];
const botguardResponse = await botguard.snapshot({ webPoSignalOutput });
const itr = await (await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json+protobuf', 'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw', 'x-user-agent': 'grpc-web-javascript/0.1' },
  body: JSON.stringify([REQUEST_KEY, botguardResponse]),
})).json();
if (!Array.isArray(itr)) throw new Error('GenerateIT failed: ' + JSON.stringify(itr).slice(0,120));
const minter = await WebPoMinter.create({ integrityToken: itr[0], estimatedTtlSecs: itr[1], mintRefreshThreshold: itr[2], websafeFallbackToken: itr[3] }, webPoSignalOutput);
console.log('WebPoMinter ready');
/* -------------------------------------------------------------------------------------- */

// n-sig evaluator for youtubei.js (runs the player script in this scope)
Platform.shim.eval = async (data) => new Function(data.output)();

const yt = await Innertube.create({ retrieve_player: true, client_type: 'WEB' });
const endpoint = new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId: VIDEO } });
const playerResponse = await endpoint.call(yt.actions, {
  playbackContext: { contentPlaybackContext: { vis: 0, splay: false, signatureTimestamp: yt.session.player?.signature_timestamp } },
  contentCheckOk: true, racyCheckOk: true, client: 'WEB', parse: true,
});
const status = playerResponse.playability_status?.status;
const serverAbrStreamingUrl = await yt.session.player?.decipher(playerResponse.streaming_data?.server_abr_streaming_url);
const ustreamer = playerResponse.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
const sabrFormats = playerResponse.streaming_data?.adaptive_formats?.map(buildSabrFormat) ?? [];
console.log(`player: status=${status} sabrUrl=${!!serverAbrStreamingUrl} ustreamer=${!!ustreamer} formats=${sabrFormats.length}`);
if (!serverAbrStreamingUrl || !ustreamer) { console.log('no SABR info:', JSON.stringify(playerResponse.playability_status).slice(0,200)); process.exit(1); }

const clientName = parseInt(Constants.CLIENT_NAME_IDS[yt.session.context.client.clientName]);
const clientVersion = yt.session.context.client.clientVersion;

const sabr = new SabrStream({
  serverAbrStreamingUrl,
  videoPlaybackUstreamerConfig: ustreamer,
  clientInfo: { clientName, clientVersion },
  formats: sabrFormats,
  poToken: await minter.mintAsWebsafeString(VIDEO),   // SABR binding = video id
});
sabr.on('streamProtectionStatusUpdate', (s) => console.log('  sps:', JSON.stringify(s).slice(0,120)));
sabr.on('reloadPlayerResponse', () => console.log('  !! reloadPlayerResponse requested'));

// selectFormats() insists on BOTH a video and an audio pick, so give it explicit
// selectors: highest-bitrate audio, and any video (discarded for audio-only).
const pickAudio = (fs) => fs.filter(f => f.mimeType?.includes('audio'))
  .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
const pickVideo = (fs) => fs.filter(f => f.mimeType?.includes('video')).sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))[0];
const audioFmt = pickAudio(sabrFormats);
console.log('audio candidate:', audioFmt?.itag, audioFmt?.mimeType, audioFmt?.bitrate, 'durMs', audioFmt?.approxDurationMs);
sabr.setDurationMs(Number(audioFmt?.approxDurationMs) || 0);
const { audioStream, selectedFormats } = await sabr.start({
  audioFormat: pickAudio,
  videoFormat: pickVideo,
  preferWebM: true,
  enabledTrackTypes: 1,   // EnabledTrackTypes.AUDIO_ONLY
});
console.log('selected:', selectedFormats.audioFormat?.itag, selectedFormats.audioFormat?.mimeType);

const reader = audioStream.getReader();
const parts = []; let total = 0;
const t0 = Date.now();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (value?.length) { parts.push(Buffer.from(value)); total += value.length; }
  if (Date.now() - t0 > 120000) { sabr.abort(); break; }
}
const buf = Buffer.concat(parts);
fs.writeFileSync('/tmp/sabr-audio.bin', buf);
const at = buf.indexOf(Buffer.from([0x1a,0x45,0xdf,0xa3]));
console.log(`RESULT: ${(total/1048576).toFixed(2)} MB in ${((Date.now()-t0)/1000).toFixed(1)}s | EBML at ${at}`);
if (at > 0) fs.writeFileSync('/tmp/sabr-audio.webm', buf.subarray(at));
