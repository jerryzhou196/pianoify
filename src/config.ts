/**
 * What the client needs to know about the outside world.
 *
 * The transcriber is no longer one of these. Mirelo is reached through this
 * site's own `/api/*` functions, because the API key bills a real account and
 * anything `VITE_*` is inlined into a bundle a browser can read — so there is
 * no transcription origin to configure here, only the chord service, which is
 * public and has no key.
 */

function base(raw: string | undefined, fallback: string): string {
  return (raw ?? fallback).trim().replace(/\/+$/, "");
}

/** The standalone chord service: CPU-only BTC chord recognition on a free
 *  Hugging Face Space. An explicitly empty value makes every chord URL a
 *  relative path, which is what the dev proxy in `vite.config.ts` forwards. */
export const CHORD_BASE = base(
  import.meta.env.VITE_CHORD_API_BASE,
  "https://jerrdeh-muscriptor-chords.hf.space",
);

/** Whether to ask for chords at all. Off with the literal `off`, because empty
 *  already means something else here (same-origin, via the dev proxy). */
export const chordServiceEnabled =
  (import.meta.env.VITE_CHORD_API_BASE ?? "").trim().toLowerCase() !== "off";

export const chordApi = (path: string) => CHORD_BASE + path;

/**
 * The longest clip this app transcribes, in seconds.
 *
 * The real cap lives in `api/_mirelo.ts`, which measures the WAV it is handed
 * and refuses anything longer — the browser cannot be trusted with a limit
 * that costs money. This copy is what stops the trim handles from opening on a
 * crop that would only be rejected, and it must match the server's.
 */
export const MAX_CLIP_SECONDS = 10;

/** How long a crop the trim handles open on. The cap, since there is no room
 *  under it worth defaulting to. */
export const CLIP_SECONDS = MAX_CLIP_SECONDS;

/**
 * The YouTube→audio service, which is self-hosted (yt-dlp behind FastAPI).
 *
 * Same shape as the chord service above: an explicitly empty value makes the
 * URLs relative, which the dev proxy forwards — and in production a rewrite in
 * `vercel.json` does the same thing at the edge. Going through this origin
 * rather than calling the service directly is what keeps the app out of the
 * service's CORS allowlist entirely.
 */
export const YTDLP_BASE = base(import.meta.env.VITE_YTDLP_API_BASE, "");

export const ytdlpApi = (path: string) => YTDLP_BASE + path;

/** Pixels per second of music on the roll. At 130 a bar of anything moderate
 *  is about a thumb's width, which is the zoom the roll was designed at. */
export const PIXELS_PER_SECOND = 130;
