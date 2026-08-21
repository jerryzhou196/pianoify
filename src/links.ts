import { ytdlpApi } from "./config";

/**
 * Turning a pasted link into a file.
 *
 * Two kinds of link, two very different machines behind them:
 *
 *   A YouTube link goes to the self-hosted yt-dlp service, which pulls
 *   YouTube's native AAC stream and copies it into an `.m4a` without
 *   re-encoding. It is the slow path — a download runs at roughly half the
 *   video's own length — and it is the reason the modal counts the seconds
 *   while it waits.
 *
 *   Anything else goes to `/api/fetch`, which is a fenced proxy: https only,
 *   no private address, an audio content type, a size ceiling. Most audio
 *   hosts refuse a cross-origin fetch, so the bytes have to come through this
 *   origin to be decodable here at all.
 *
 * Both come back as a `File`, indistinguishable from a dropped one by the time
 * the modal sees it.
 */

export class LinkError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LinkError";
  }
}

const YOUTUBE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

export function isYouTube(raw: string): boolean {
  try {
    return YOUTUBE.test(new URL(raw.trim()).hostname);
  } catch {
    return false;
  }
}

export async function fetchLink(raw: string, signal?: AbortSignal): Promise<File> {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new LinkError("that does not look like a link — it needs to start with https://");
  }
  return isYouTube(url) ? fetchYouTube(url, signal) : fetchDirect(url, signal);
}

/**
 * Download a video's audio through the yt-dlp service.
 *
 * The service is reached at a path on this origin rather than at its own — the
 * dev server proxies `/ytdlp` and `vercel.json` rewrites it in production —
 * which means the browser never makes a cross-origin request and the app never
 * has to appear in the service's CORS allowlist. It validates the YouTube host
 * and the video id itself, so nothing here needs to.
 */
async function fetchYouTube(url: string, signal?: AbortSignal): Promise<File> {
  const resp = await fetch(ytdlpApi(`/ytdlp/download?url=${encodeURIComponent(url)}`), { signal });
  if (!resp.ok) {
    throw new LinkError(await ytdlpMessage(resp), resp.status);
  }
  const blob = await resp.blob();
  return new File([blob], dispositionName(resp) ?? "youtube-audio.m4a", {
    type: blob.type || "audio/mp4",
  });
}

/** The service answers FastAPI-style. Its own `detail` is the best sentence
 *  available for a rejected link; the status codes it documents are worth
 *  translating, because "502" tells nobody that the video is geo-blocked. */
async function ytdlpMessage(resp: Response): Promise<string> {
  const body = await resp.json().catch(() => null);
  const detail = typeof body?.detail === "string" ? body.detail : null;
  if (detail) return detail.toLowerCase();
  if (resp.status === 502) return "youtube would not give that one up — it may be private, removed, or geo-blocked";
  if (resp.status === 504) return "that download timed out — try a shorter video";
  return `the download service answered ${resp.status}`;
}

/** The filename the service put in `Content-Disposition`, which is the video's
 *  own title. Same-origin here, so the header is readable. */
function dispositionName(resp: Response): string | null {
  const header = resp.headers.get("Content-Disposition");
  const match = header && /filename="?([^";]+)"?/i.exec(header);
  if (!match) return null;
  return match[1].replace(/_/g, " ");
}

async function fetchDirect(url: string, signal?: AbortSignal): Promise<File> {
  const resp = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, { signal });
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    throw new LinkError(body?.error ?? `that link answered ${resp.status}`, resp.status);
  }
  const blob = await resp.blob();
  const name = decodeURIComponent(resp.headers.get("X-Source-Name") ?? "audio");
  return new File([blob], name, { type: blob.type || "audio/mpeg" });
}
