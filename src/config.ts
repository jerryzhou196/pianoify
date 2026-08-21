/**
 * What the client needs to know about the outside world.
 *
 * Mirelo is not one of these. It is reached through this site's own `/api/*`
 * functions, because the API key bills a real account and anything `VITE_*` is
 * inlined into a bundle a browser can read. The other three backends — chords,
 * yt-dlp, and the GPU box — are public or same-origin, and are named here.
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
 * The longest clip Mirelo transcribes, in seconds.
 *
 * The real cap lives in `api/_mirelo.ts`, which measures the WAV header it is
 * handed and refuses anything longer — the browser cannot be trusted with a
 * limit that costs money. This copy is what stops the trim handles from
 * opening on a crop that would only be rejected, and it must match the
 * server's.
 *
 * Ten minutes is Mirelo's own number, not one this app chose: its preflight
 * refuses a longer duration outright. The GPU box has no equivalent — see
 * `maxSeconds` in `src/models.ts`, which is where the two are told apart.
 */
export const MAX_CLIP_SECONDS = 600;

/** How long a crop the trim handles open on, whatever the model would allow.
 *
 *  Ten seconds, still. The handles now stretch as far as the model will go,
 *  but the length that costs the least to be wrong about is the one they open
 *  on — a dropped file quotes 25 credits until someone widens it on purpose,
 *  rather than 1500 because it happened to be an album track. */
export const CLIP_SECONDS = 10;

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

/**
 * The GPU box that runs MuScriptor, the other transcriber in the picker.
 *
 * The default is a path on this origin, not the box's own hostname: the box
 * answers a browser only from origins in its `MUSCRIPTOR_ALLOWED_ORIGINS`, and
 * a Vercel preview URL is never one of them. `/gpu/*` is rewritten to the box
 * by `vercel.json` in production and proxied by the dev server locally, which
 * makes every call same-origin to the browser and server-to-server to the box,
 * where CORS does not apply.
 *
 * Point this at `https://muscriptor-api.jerryzhou.ca` to talk to the box
 * directly — which works only from an origin it lists. Blank means the default
 * rather than same-origin-with-no-prefix, which the chord base above uses it
 * for: there the prefix *is* the path the proxy matches, so an empty base
 * would only produce a URL nothing serves.
 */
export const MUSCRIPTOR_BASE = base(
  import.meta.env.VITE_MUSCRIPTOR_API_BASE?.trim() || undefined,
  "/gpu",
);

export const muscriptorApi = (path: string) => MUSCRIPTOR_BASE + path;

/** Pixels per second of music on the roll. At 130 a bar of anything moderate
 *  is about a thumb's width, which is the zoom the roll was designed at. */
export const PIXELS_PER_SECOND = 130;
