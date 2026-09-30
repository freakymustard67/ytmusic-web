/**
 * YouTube Music metadata layer.
 *
 * Search, browse and song/video details all work from plain Node with no browser
 * and no PoToken (docs/FINDINGS.md §2). Only *streaming* needs Chromium, which
 * lives in browser.ts.
 */

import { Innertube } from 'youtubei.js';

export interface Track {
  videoId: string;
  title: string;
  artists: string[];
  album: string | null;
  durationSec: number | null;
  durationText: string | null;
  thumbnail: string | null;
  kind: 'song' | 'video';
  explicit: boolean;
}

let client: Innertube | null = null;
let creating: Promise<Innertube> | null = null;

export async function yt(): Promise<Innertube> {
  if (client) return client;
  if (creating) return creating;
  creating = Innertube.create({
    // Must stay true — with retrieve_player:false, streaming data parsing breaks.
    retrieve_player: true,
    lang: 'en',
    location: 'US',
  });
  try {
    client = await creating;
    return client;
  } finally {
    creating = null;
  }
}

function pickThumb(thumbs: any[] | undefined): string | null {
  if (!thumbs?.length) return null;
  const sorted = [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url ?? null;
}

function parseDuration(text: string | undefined): number | null {
  if (!text) return null;
  const parts = text.split(':').map((p) => parseInt(p, 10));
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function toTrack(item: any, kind: 'song' | 'video'): Track | null {
  if (!item?.id) return null;
  const artists =
    item.artists?.map((a: any) => a.name).filter(Boolean) ??
    (item.author ? [item.author.name ?? String(item.author)] : []);
  return {
    videoId: item.id,
    title: item.title ?? '(untitled)',
    artists,
    album: item.album?.name ?? null,
    durationSec: item.duration?.seconds ?? parseDuration(item.duration?.text),
    durationText: item.duration?.text ?? null,
    thumbnail: pickThumb(item.thumbnail?.contents ?? item.thumbnails),
    kind,
    explicit: !!item.is_explicit,
  };
}

export interface SearchResults {
  songs: Track[];
  videos: Track[];
  albums: any[];
  artists: any[];
  playlists: any[];
}

export async function search(query: string, type: 'song' | 'video' | 'all' = 'all'): Promise<SearchResults> {
  const y = await yt();
  const out: SearchResults = { songs: [], videos: [], albums: [], artists: [], playlists: [] };

  if (type === 'song' || type === 'video') {
    const r = await y.music.search(query, { type });
    const list = type === 'song' ? r.songs?.contents : r.videos?.contents;
    const tracks = (list ?? []).map((i: any) => toTrack(i, type)).filter(Boolean) as Track[];
    if (type === 'song') out.songs = tracks;
    else out.videos = tracks;
    return out;
  }

  // Search each shelf independently: the combined response shape changes often,
  // and a failure in one shelf should not lose the others.
  const [songs, videos, albums, artists, playlists] = await Promise.allSettled([
    y.music.search(query, { type: 'song' }),
    y.music.search(query, { type: 'video' }),
    y.music.search(query, { type: 'album' }),
    y.music.search(query, { type: 'artist' }),
    y.music.search(query, { type: 'playlist' }),
  ] as const);

  if (songs.status === 'fulfilled') {
    out.songs = (songs.value.songs?.contents ?? []).map((i: any) => toTrack(i, 'song')).filter(Boolean) as Track[];
  }
  if (videos.status === 'fulfilled') {
    out.videos = (videos.value.videos?.contents ?? []).map((i: any) => toTrack(i, 'video')).filter(Boolean) as Track[];
  }
  if (albums.status === 'fulfilled') {
    out.albums = (albums.value.albums?.contents ?? []).map((a: any) => ({
      browseId: a.id, title: a.title, artists: a.artists?.map((x: any) => x.name) ?? [],
      year: a.year ?? null, thumbnail: pickThumb(a.thumbnail?.contents),
    }));
  }
  if (artists.status === 'fulfilled') {
    out.artists = (artists.value.artists?.contents ?? []).map((a: any) => ({
      browseId: a.id, name: a.name, subscribers: a.subscribers?.text ?? null,
      thumbnail: pickThumb(a.thumbnail?.contents),
    }));
  }
  if (playlists.status === 'fulfilled') {
    out.playlists = (playlists.value.playlists?.contents ?? []).map((p: any) => ({
      browseId: p.id, title: p.title, author: p.author?.name ?? null,
      itemCount: p.item_count ?? null, thumbnail: pickThumb(p.thumbnail?.contents),
    }));
  }
  return out;
}

export async function getTrack(videoId: string): Promise<Track | null> {
  const y = await yt();
  const info = await y.music.getInfo(videoId).catch(() => null);
  if (!info) {
    const basic = await y.getBasicInfo(videoId).catch(() => null);
    if (!basic) return null;
    const d: any = basic.basic_info;
    return {
      videoId, title: d.title ?? '(untitled)', artists: d.author ? [d.author] : [],
      album: null, durationSec: d.duration ?? null, durationText: null,
      thumbnail: pickThumb(d.thumbnail), kind: 'video', explicit: false,
    };
  }
  const d: any = info.basic_info ?? {};
  return {
    videoId,
    title: d.title ?? '(untitled)',
    artists: d.author ? [d.author] : [],
    album: d.album ?? null,
    durationSec: d.duration ?? null,
    durationText: null,
    thumbnail: pickThumb(d.thumbnail),
    kind: 'song',
    explicit: false,
  };
}

/** Radio/next-songs for a video, used for autoplay/queue continuation. */
export async function getUpNext(videoId: string, limit = 25): Promise<Track[]> {
  const y = await yt();
  const r: any = await y.music.getUpNext(videoId).catch(() => null);
  const items = r?.contents ?? r?.playlist?.contents ?? [];
  return items
    .map((i: any) => toTrack(i, i?.video_id || i?.id ? 'song' : 'song'))
    .filter(Boolean)
    .slice(0, limit) as Track[];
}

export async function getLyricsBrowseId(videoId: string): Promise<string | null> {
  const y = await yt();
  const info: any = await y.music.getInfo(videoId).catch(() => null);
  return info?.lyrics?.id ?? null;
}
