// UMP (YouTube Unified Media Protocol) demuxer — derived empirically.
//
// A UMP audio response body is:  [small protobuf header][raw container bytes]
// There is NO length prefix before the header; the first byte is a protobuf
// field tag. The header carries the videoId and itag. The container that
// follows is WebM/EBML for Opus (itag 251/250/249) or ISO-BMFF for AAC
// (itag 140/139) — so we locate the container magic rather than parse the
// protobuf schema, which is robust across itags.

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const FTYP_MAGIC = Buffer.from('ftyp', 'latin1');

export type Container = 'webm' | 'mp4' | 'unknown';

export interface DemuxedFrame {
  container: Container;
  /** Protobuf header bytes (metadata only — never append these to media). */
  header: Buffer;
  /** Raw container bytes, safe to concatenate with other frames' media. */
  media: Buffer;
}

export function demuxUmp(buf: Buffer): DemuxedFrame {
  const webmAt = buf.indexOf(EBML_MAGIC);
  if (webmAt >= 0) {
    return { container: 'webm', header: buf.subarray(0, webmAt), media: buf.subarray(webmAt) };
  }
  const ftypAt = buf.indexOf(FTYP_MAGIC);
  if (ftypAt >= 4) {
    // "ftyp" is the box *type*; the box starts 4 bytes earlier at its size field.
    const start = ftypAt - 4;
    return { container: 'mp4', header: buf.subarray(0, start), media: buf.subarray(start) };
  }
  // Unknown framing: pass through untouched so playback can still be attempted.
  return { container: 'unknown', header: Buffer.alloc(0), media: buf };
}

/**
 * Recover the videoId from a UMP header.
 *
 * YouTube serves ads from the same endpoint, so a session will happily negotiate
 * *ad* audio against the requested video. Ads carry their own videoId in the UMP
 * header, which lets us tell the requested track apart from pre-roll audio —
 * without this, capture ends after ~20 seconds of advertisement.
 */
export function videoIdFromHeader(header: Buffer): string | null {
  const s = header.toString('latin1');
  const m = s.match(/[A-Za-z0-9_-]{11}/);
  return m ? m[0] : null;
}

/** True when this UMP header belongs to the given video (i.e. not an ad). */
export function matchesVideo(header: Buffer, videoId: string): boolean {
  return videoIdFromHeader(header) === videoId;
}

export function describeHeader(header: Buffer): { bytes: number; videoId: string | null } {
  return { bytes: header.length, videoId: videoIdFromHeader(header) };
}
