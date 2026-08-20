/**
 * Where the two backends live, and how much audio we send them.
 *
 * There are two, because transcription and chord recognition want different
 * hardware: notes come from a GPU box running muscriptor, chords from BTC on a
 * free CPU-only Hugging Face Space. Splitting them keeps the GPU rented only
 * for the thing that actually needs one.
 *
 * Both are `VITE_*`, so they are inlined at build time and a redeploy is what
 * changes them — but both also carry the deployed defaults, so a fresh clone
 * runs against the real backends without an `.env.local`.
 */

/**
 * Resolve one base origin.
 *
 * An unset variable falls back to the deployed backend, so a fresh clone runs
 * against the real thing. An explicitly *empty* one resolves to `""`, which
 * makes every URL below a same-origin relative path — that is what the dev
 * proxy in vite.config.ts is keyed on, and it is a working configuration, not
 * a disabled one. The trailing slash goes because `base + "/transcribe"` must
 * not become `//transcribe`, which is a different (broken) URL.
 */
function base(raw: string | undefined, fallback: string): string {
  return (raw ?? fallback).trim().replace(/\/+$/, "");
}

export const TRANSCRIBE_BASE = base(
  import.meta.env.VITE_TRANSCRIBE_API_BASE,
  "https://muscriptor-api.jerryzhou.ca",
);

export const CHORD_BASE = base(
  import.meta.env.VITE_CHORD_API_BASE,
  "https://jerrdeh-muscriptor-chords.hf.space",
);

/**
 * Whether to ask the standalone chord service at all.
 *
 * Turned off with the literal `off` rather than with an empty string, because
 * empty already means something else here (same-origin, via the dev proxy).
 * When it is off — or when the Space is asleep and never answers — chords come
 * from the ones `/transcribe` embeds in its final event instead. It is one
 * source or the other, never both, so there is only ever one chord track to
 * reason about.
 */
export const chordServiceEnabled =
  (import.meta.env.VITE_CHORD_API_BASE ?? "").trim().toLowerCase() !== "off";

/**
 * Seconds of audio uploaded per transcription.
 *
 * Not a limit the server publishes — `/transcribe` accepts far longer files.
 * It is a latency budget: the box transcribes a chunk at a time and the client
 * holds the connection open the whole while, so a three-minute upload is a
 * three-minute wait behind a single global lock. Fifteen seconds of the most
 * musical part of the file is the thing worth hearing back, and it returns
 * fast enough that the page stays a toy you can play with.
 */
export const CLIP_SECONDS = Math.max(
  1,
  Number(import.meta.env.VITE_CLIP_SECONDS ?? 15) || 15,
);

export const transcribeApi = (path: string) => TRANSCRIBE_BASE + path;
export const chordApi = (path: string) => CHORD_BASE + path;
