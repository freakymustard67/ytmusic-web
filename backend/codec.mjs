import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath:'/usr/bin/chromium', headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const p = await (await b.newContext()).newPage();
await p.goto('about:blank');
const r = await p.evaluate(() => {
  const v = document.createElement('video');
  const a = document.createElement('audio');
  const types = {
    'audio/webm; codecs="opus"': a.canPlayType('audio/webm; codecs="opus"'),
    'audio/webm; codecs="vorbis"': a.canPlayType('audio/webm; codecs="vorbis"'),
    'audio/mp4; codecs="mp4a.40.2"': a.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    'audio/mpeg': a.canPlayType('audio/mpeg'),
    'video/mp4; codecs="avc1.42E01E"': v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
    'video/webm; codecs="vp9"': v.canPlayType('video/webm; codecs="vp9"'),
  };
  const mse = {
    opus: MediaSource.isTypeSupported('audio/webm; codecs="opus"'),
    aac: MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'),
    vp9: MediaSource.isTypeSupported('video/webm; codecs="vp9"'),
    avc: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'),
  };
  return { canPlayType: types, mse, ua: navigator.userAgent.slice(0, 90) };
});
console.log(JSON.stringify(r, null, 2));
await b.close();
