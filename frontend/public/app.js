/**
 * Front-end: search, queue, playback, synced lyrics, PWA.
 *
 * Audio is streamed from /api/stream/:videoId. The server relays it because
 * Google's CDN sends no CORS headers, so the browser cannot fetch it directly.
 * Seeking works once the server has cached the track (it advertises
 * accept-ranges: bytes at that point).
 */

const $ = (id) => document.getElementById(id);
const audio = $('audio');

/** @typedef {{videoId:string,title:string,artists:string[],album:?string,durationSec:?number,durationText:?string,thumbnail:?string,kind:string}} Track */

const state = {
  queue: [],
  index: -1,
  shuffle: false,
  repeat: 'off',
  tab: 'songs',
  results: null,
  query: '',
  lyrics: null,
  lyricLines: [],
  activeLyric: -1,
  backdrop: null,
};

/* ------------------------------- utilities ------------------------------ */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

/* -------------------------------- search -------------------------------- */

const SUGGESTIONS = ['Arijit Singh', 'lofi hip hop', 'Taylor Swift', 'AR Rahman', 'jazz cafe', 'weeknd', 'bollywood 90s', 'synthwave'];

function renderChips() {
  $('chips').innerHTML = SUGGESTIONS.map((s) => `<button data-q="${esc(s)}">${esc(s)}</button>`).join('');
  $('chips').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      $('q').value = b.dataset.q;
      doSearch(b.dataset.q);
    }),
  );
}

function trackRow(t, i) {
  const sub = [t.artists?.join(', '), t.album].filter(Boolean).join(' • ');
  return `<button class="row" data-i="${i}">
    <img loading="lazy" src="${esc(t.thumbnail ?? '')}" alt="" onerror="this.style.visibility='hidden'"/>
    <div class="rowText">
      <div class="rowTitle">${esc(t.title)}</div>
      <div class="rowSub">${esc(sub)}</div>
    </div>
    ${t.kind === 'video' ? '<span class="badge">VIDEO</span>' : ''}
    <span class="rowDur">${esc(t.durationText ?? fmtTime(t.durationSec ?? 0))}</span>
  </button>`;
}

function card(item, kind) {
  const sub = kind === 'artists' ? item.subscribers ?? '' : kind === 'albums' ? (item.artists?.join(', ') ?? '') : item.author ?? '';
  return `<button class="card ${kind === 'artists' ? 'round' : ''}" data-kind="${kind}" data-id="${esc(item.browseId)}">
    <div class="cardArt"><img loading="lazy" src="${esc(item.thumbnail ?? '')}" alt="" onerror="this.style.visibility='hidden'"/></div>
    <div class="cardTitle">${esc(item.title ?? item.name)}</div>
    <div class="cardSub">${esc(sub)}</div>
  </button>`;
}

function render() {
  const r = state.results;
  const wrap = $('results');
  if (!r) { wrap.hidden = true; $('welcome').hidden = false; return; }
  $('welcome').hidden = true;
  wrap.hidden = false;

  let html = '';
  if (state.tab === 'songs' || state.tab === 'videos') {
    const list = state.tab === 'songs' ? r.songs : r.videos;
    html = list?.length
      ? `<div class="rows">${list.map(trackRow).join('')}</div>`
      : `<p class="muted">No ${state.tab} found.</p>`;
    state.currentList = list ?? [];
  } else {
    const list = r[state.tab] ?? [];
    html = list.length
      ? `<div class="grid">${list.map((x) => card(x, state.tab)).join('')}</div>`
      : `<p class="muted">No ${state.tab} found.</p>`;
    state.currentList = [];
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll('.row').forEach((el) =>
    el.addEventListener('click', () => {
      playFromList(state.currentList, Number(el.dataset.i));
    }),
  );
  wrap.querySelectorAll('.card').forEach((el) =>
    el.addEventListener('click', () => toast('Albums, artists and playlists are not browsable yet — search a song or video.')),
  );
}

async function doSearch(q) {
  if (!q?.trim()) return;
  state.query = q.trim();
  $('results').hidden = false;
  $('welcome').hidden = true;
  $('results').innerHTML = '<div class="spinner"></div>';
  try {
    const r = await api(`/api/search?q=${encodeURIComponent(state.query)}&type=all`);
    state.results = r;
    render();
  } catch (err) {
    $('results').innerHTML = `<p class="muted">Search failed: ${esc(err.message)}</p>`;
  }
}

/* ------------------------------- playback ------------------------------- */

function playFromList(list, i) {
  state.queue = list.slice();
  state.index = i;
  play();
}

async function play() {
  const t = state.queue[state.index];
  if (!t) return;
  renderQueue();
  render();

  $('npTitle').textContent = t.title;
  $('npArtist').textContent = [t.artists?.join(', '), t.album].filter(Boolean).join(' • ');
  $('art').src = t.thumbnail ?? '';
  $('likeBtn').disabled = false;
  document.title = `${t.title} • Music`;

  // Negotiate on the server first, then point the element at the stream.
  toast('Starting…', 8000);
  try {
    await api(`/api/play/${t.videoId}`, { method: 'POST' });
  } catch (err) {
    toast(`Could not start playback: ${err.message}`, 5000);
    return;
  }
  audio.src = `/api/stream/${t.videoId}`;
  audio.load();
  try {
    await audio.play();
    toast('Playing', 900);
  } catch {
    toast('Press play to start', 1500);
  }

  setMediaSession(t);
  loadLyrics(t);
}

/* ------------------------------ media session --------------------------- */

function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artists?.join(', ') ?? '',
    album: t.album ?? '',
    artwork: t.thumbnail ? [{ src: t.thumbnail, sizes: '512x512', type: 'image/jpeg' }] : [],
  });
  const h = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    previoustrack: prev,
    nexttrack: next,
    seekbackward: () => { audio.currentTime = Math.max(0, audio.currentTime - 10); },
    seekforward: () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); },
    seekto: (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; },
  };
  for (const [k, fn] of Object.entries(h)) {
    try { navigator.mediaSession.setActionHandler(k, fn); } catch {}
  }
}

/* -------------------------------- queue --------------------------------- */

function renderQueue() {
  $('queueCount').textContent = String(state.queue.length);
  const ol = $('queueList');
  ol.innerHTML = state.queue
    .map(
      (t, i) => `<li class="${i === state.index ? 'active' : ''}" data-i="${i}">
        <img loading="lazy" src="${esc(t.thumbnail ?? '')}" alt="" onerror="this.style.visibility='hidden'"/>
        <div class="qText"><div class="qTitle">${esc(t.title)}</div><div class="qSub">${esc(t.artists?.join(', ') ?? '')}</div></div>
      </li>`,
    )
    .join('');
  ol.querySelectorAll('li').forEach((li) =>
    li.addEventListener('click', () => { state.index = Number(li.dataset.i); play(); }),
  );
}

function next() {
  if (!state.queue.length) return;
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (state.shuffle) {
    state.index = Math.floor(Math.random() * state.queue.length);
  } else if (state.index + 1 < state.queue.length) {
    state.index++;
  } else if (state.repeat === 'all') {
    state.index = 0;
  } else {
    audio.pause();
    return;
  }
  play();
}

function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 4) { audio.currentTime = 0; return; }
  state.index = state.index > 0 ? state.index - 1 : state.queue.length - 1;
  play();
}

/* -------------------------------- lyrics -------------------------------- */

async function loadLyrics(t) {
  state.lyrics = null;
  state.lyricLines = [];
  state.activeLyric = -1;
  $('lyricsTitle').textContent = t.title;
  $('lyricsSource').textContent = '';
  $('lyricsBody').innerHTML = '<div class="spinner"></div>';
  try {
    const params = new URLSearchParams({
      title: t.title,
      artist: (t.artists ?? []).join(','),
      ...(t.album ? { album: t.album } : {}),
      ...(t.durationSec ? { duration: String(t.durationSec) } : {}),
    });
    const l = await api(`/api/lyrics/${t.videoId}?${params}`);
    state.lyrics = l;
    state.lyricLines = l.lines ?? [];
    $('lyricsSource').textContent = `${l.source}${l.synced ? ' • synced' : ''}`;
    renderLyrics();
  } catch {
    $('lyricsBody').innerHTML = '<p class="muted">No lyrics available for this track.</p>';
  }
}

function renderLyrics() {
  const body = $('lyricsBody');
  if (!state.lyricLines.length) {
    body.innerHTML = '<p class="muted">No lyrics available.</p>';
    return;
  }
  const synced = state.lyrics?.synced && state.lyricLines.some((l) => l.time != null);
  body.innerHTML = state.lyricLines
    .map((l, i) => `<div class="lyricLine ${synced ? '' : 'plain'}" data-i="${i}" data-t="${l.time ?? ''}">${esc(l.text)}</div>`)
    .join('');
  if (synced) {
    body.querySelectorAll('.lyricLine').forEach((el) =>
      el.addEventListener('click', () => {
        const t = Number(el.dataset.t);
        if (Number.isFinite(t)) { audio.currentTime = t; audio.play(); }
      }),
    );
  }
}

function syncLyrics() {
  if (!state.lyrics?.synced || !state.lyricLines.length) return;
  const now = audio.currentTime + 0.15;
  let idx = -1;
  for (let i = 0; i < state.lyricLines.length; i++) {
    const t = state.lyricLines[i].time;
    if (t != null && t <= now) idx = i;
    else if (t != null && t > now) break;
  }
  if (idx === state.activeLyric) return;
  state.activeLyric = idx;
  const body = $('lyricsBody');
  body.querySelectorAll('.lyricLine.active').forEach((el) => el.classList.remove('active'));
  const el = body.querySelector(`.lyricLine[data-i="${idx}"]`);
  if (el) {
    el.classList.add('active');
    if (!$('lyricsOverlay').hidden && document.visibilityState === 'visible') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

/* --------------------------------- wiring -------------------------------- */

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  doSearch($('q').value);
});

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  $('tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  render();
});

$('homeBtn').addEventListener('click', () => {
  state.results = null;
  $('q').value = '';
  document.title = 'Music';
  render();
});

$('playBtn').addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
$('nextBtn').addEventListener('click', next);
$('prevBtn').addEventListener('click', prev);

$('shuffleBtn').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  $('shuffleBtn').classList.toggle('active', state.shuffle);
  toast(state.shuffle ? 'Shuffle on' : 'Shuffle off', 1200);
});

$('repeatBtn').addEventListener('click', () => {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  $('repeatBtn').classList.toggle('active', state.repeat !== 'off');
  $('repeatBtn').title = `Repeat: ${state.repeat}`;
  toast(`Repeat ${state.repeat}`, 1200);
});

$('queueBtn').addEventListener('click', () => {
  const p = $('queuePanel');
  p.hidden = !p.hidden;
});
$('queueClose').addEventListener('click', () => { $('queuePanel').hidden = true; });

$('lyricsBtn').addEventListener('click', () => {
  const o = $('lyricsOverlay');
  o.hidden = !o.hidden;
  if (!o.hidden) syncLyrics();
});
$('lyricsClose').addEventListener('click', () => { $('lyricsOverlay').hidden = true; });

$('likeBtn').addEventListener('click', async () => {
  const t = state.queue[state.index];
  if (!t) return;
  toast('Preparing download…', 60_000);
  try {
    const res = await fetch(`/api/download/${t.videoId}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t.title.replace(/[^\w\-. ]+/g, '_')}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Downloaded', 2200);
  } catch (err) {
    toast(`Download failed: ${err.message}`, 4000);
  }
});

const seek = $('seek');
let seeking = false;
seek.addEventListener('input', () => { seeking = true; });
seek.addEventListener('change', () => {
  if (audio.duration) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
  seeking = false;
});

$('vol').addEventListener('input', () => { audio.volume = Number($('vol').value) / 100; });

audio.addEventListener('timeupdate', () => {
  if (!seeking && audio.duration) {
    seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    $('curTime').textContent = fmtTime(audio.currentTime);
  }
  syncLyrics();
});
audio.addEventListener('loadedmetadata', () => {
  $('durTime').textContent = fmtTime(audio.duration);
});
audio.addEventListener('play', () => {
  $('playPath').setAttribute('d', 'M6 5h4v14H6zm8 0h4v14h-4z');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => {
  $('playPath').setAttribute('d', 'M8 5v14l11-7z');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});
audio.addEventListener('ended', next);
audio.addEventListener('error', () => {
  if (audio.src) toast('Playback error — the track may be unavailable or the session expired.', 4500);
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
  if (e.code === 'ArrowRight' && e.shiftKey) next();
  if (e.code === 'ArrowLeft' && e.shiftKey) prev();
  if (e.key === 'l') $('lyricsBtn').click();
  if (e.key === 'q') $('queueBtn').click();
  if (e.key === '/') { e.preventDefault(); $('q').focus(); }
});

/* ---------------------------------- PWA ---------------------------------- */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

renderChips();
render();
