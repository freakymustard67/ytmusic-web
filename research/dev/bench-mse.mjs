// Can a client decode relayed UMP bytes straight into MSE SourceBuffer?
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const ump = fs.readFileSync('/tmp/seg-concat.bin');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext()).newPage();
await page.goto('about:blank');

const res = await page.evaluate(async ({ b64 }) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ms = new MediaSource();
  const v = document.createElement('video');
  v.src = URL.createObjectURL(ms); v.muted = true;
  document.body.appendChild(v);
  await new Promise(r => ms.addEventListener('sourceopen', r, { once: true }));
  const log = [];
  for (const mime of ['audio/mp4; codecs="opus"', 'audio/mp4; codecs="mp4a.40.2"', 'audio/webm; codecs="opus"']) {
    if (!MediaSource.isTypeSupported(mime)) { log.push(`${mime}: unsupported`); continue; }
    try {
      const sb = ms.addSourceBuffer(mime);
      await new Promise((resolve, reject) => {
        sb.addEventListener('updateend', resolve, { once: true });
        sb.addEventListener('error', () => reject(new Error('sb error')), { once: true });
        try { sb.appendBuffer(bytes); } catch (e) { reject(e); }
        setTimeout(() => reject(new Error('timeout')), 8000);
      });
      log.push(`${mime}: appended OK, buffered=${sb.buffered.length ? sb.buffered.end(0).toFixed(2) : 0}s`);
    } catch (e) { log.push(`${mime}: ${String(e.message).slice(0,80)}`); }
  }
  return { log, duration: ms.duration, readyState: v.readyState };
}, { b64: ump.toString('base64') });

console.log(JSON.stringify(res, null, 2));
await browser.close();
