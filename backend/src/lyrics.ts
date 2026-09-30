/**
 * Lyrics layer.
 *
 * Metrolist gets its time-synced lyrics from the Better Lyrics ecosystem, whose
 * providers (LRCLIB, Unison, Musixmatch, …) are ordinary HTTP APIs. YouTube Music
 * itself also exposes time-synced lyrics for many tracks, so we try that first
 * (no third-party dependency) and fall back to LRCLIB, which is free and needs
 * no API key.
 *
 * Output is a normalised shape:
 *   { synced: boolean, lines: [{ time: seconds|null, text }] }
 */

import { yt } from './ytmusic.js';

export interface LyricLine {
  time: number | null;
  text: string;
}

export interface Lyrics {
  synced: boolean;
  source: string;
  lines: LyricLine[];
}

/** Parse LRC ("[mm:ss.xx] text") into timed lines. */
function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/^\s*\[(\d+):(\d+(?:[.:]\d+)?)\]\s*(.*)$/);
    if (!m) continue;
    const mins = parseInt(m[1], 10);
    const secs = parseFloat(m[2].replace(':', '.'));
    const text = m[3].trim();
    if (!text) continue;
    lines.push({ time: +(mins * 60 + secs).toFixed(2), text });
  }
  return lines.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

function asPlain(text: string): LyricLine[] {
  return text
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text) => ({ time: null, text }));
}

/** YouTube Music's own timed lyrics. */
async function fromYouTubeMusic(videoId: string): Promise<Lyrics | null> {
  try {
    const y = await yt();
    const info: any = await y.music.getInfo(videoId);
    const browseId = info?.lyrics?.id;
    if (!browseId) return null;
    const lyrics: any = await y.music.getLyrics(browseId);
    if (!lyrics) return null;

    // Shape 1: already-timed lines
    const timed = lyrics?.lines ?? lyrics?.lyrics?.lines;
    if (Array.isArray(timed) && timed.length && typeof timed[0] === 'object') {
      const lines: LyricLine[] = timed
        .map((l: any) => ({
          time: typeof l.start_time === 'number' ? l.start_time / 1000 : (l.time ?? null),
          text: String(l.text ?? '').trim(),
        }))
        .filter((l: LyricLine) => l.text);
      if (lines.length) {
        const anyTimed = lines.some((l) => l.time !== null);
        return { synced: anyTimed, source: 'youtube-music', lines: anyTimed ? lines.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)) : lines };
      }
    }

    // Shape 2: a plain text blob that may itself contain LRC
    const text: string | undefined = lyrics?.text ?? lyrics?.description?.toString?.();
    if (text) {
      const parsed = parseLrc(text);
      if (parsed.length) return { synced: true, source: 'youtube-music', lines: parsed };
      const plain = asPlain(text);
      if (plain.length) return { synced: false, source: 'youtube-music', lines: plain };
    }
    return null;
  } catch {
    return null;
  }
}

/** LRCLIB — free, no key, real time-synced lyrics for a huge catalogue. */
async function fromLrclib(track: { title: string; artists: string[]; album?: string | null; durationSec?: number | null }): Promise<Lyrics | null> {
  try {
    const artist = track.artists[0] ?? '';
    const params = new URLSearchParams({
      track_name: track.title,
      artist_name: artist,
    });
    if (track.album) params.set('album_name', track.album);
    if (track.durationSec) params.set('duration', String(Math.round(track.durationSec)));

    const headers = { 'user-agent': 'ytmusic-web (https://github.com/)' };
    let hit: any = null;

    const exact = await fetch(`https://lrclib.net/api/get?${params}`, { headers });
    if (exact.ok) hit = await exact.json();

    if (!hit) {
      const q = new URLSearchParams({ q: `${track.title} ${artist}`.trim() });
      const search = await fetch(`https://lrclib.net/api/search?${q}`, { headers });
      if (search.ok) {
        const list: any[] = await search.json();
        hit = list.find((x) => x.syncedLyrics) ?? list[0] ?? null;
      }
    }
    if (!hit) return null;

    if (hit.syncedLyrics) {
      const lines = parseLrc(hit.syncedLyrics);
      if (lines.length) return { synced: true, source: 'lrclib', lines };
    }
    if (hit.plainLyrics) {
      const lines = asPlain(hit.plainLyrics);
      if (lines.length) return { synced: false, source: 'lrclib', lines };
    }
    return null;
  } catch {
    return null;
  }
}

export async function getLyrics(videoId: string, meta?: { title: string; artists: string[]; album?: string | null; durationSec?: number | null }): Promise<Lyrics | null> {
  const ytm = await fromYouTubeMusic(videoId);
  if (ytm?.synced) return ytm; // prefer synced over anything else

  if (meta) {
    const lrclib = await fromLrclib(meta);
    if (lrclib?.synced) return lrclib;
    if (ytm) return ytm;
    if (lrclib) return lrclib;
    return null;
  }
  return ytm;
}
