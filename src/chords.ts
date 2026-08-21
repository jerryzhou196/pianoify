import { chordApi, chordServiceEnabled } from "./config";
import type { Chord } from "./types";

/**
 * Chords, from the one backend this app still runs itself.
 *
 * Mirelo transcribes notes, not harmony, so the chord track comes from a
 * separate CPU-only Hugging Face Space running BTC. It is worth keeping for
 * three things the notes alone cannot do: the bands across the roll, the symbol
 * in the transport, and — least visible, most audible — the pedal. The engine
 * lifts the damper pedal on every chord change, which is what a pianist does
 * and the only reason a pedalled passage stays playable instead of collecting
 * into one chord of the entire clip.
 *
 * Everything here fails soft. A sleeping chord service must never turn a good
 * transcription into an error.
 */

const WARM_ATTEMPTS = 4;
const WARM_RETRY_MS = 6000;

/**
 * Ping the Space's `/health` so it is awake by the time a file is picked.
 *
 * A free Space is stopped when idle and takes tens of seconds to come back, and
 * the first request pays for that boot. Sending it while someone is still
 * dragging the trim handles usually hides the whole wake-up. It reports
 * `"loading"` while its model is still coming up, which is worth another ping —
 * a request sent then would only queue behind the load.
 */
export async function warmChordService(signal?: AbortSignal): Promise<boolean> {
  if (!chordServiceEnabled) return false;
  for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt++) {
    if (signal?.aborted) return false;
    try {
      const resp = await fetch(chordApi("/health"), { signal });
      if (resp.ok) {
        const body = (await resp.json()) as { status?: string };
        if (body.status !== "loading") return true;
      }
    } catch {
      // Asleep, booting, or unreachable — indistinguishable from here, and all
      // handled the same way: try again, then let it go.
    }
    if (attempt < WARM_ATTEMPTS) await sleep(WARM_RETRY_MS, signal);
  }
  return false;
}

/**
 * Recognize the chords in `file`.
 *
 * The service does its own beat tracking and snaps the boundaries it returns to
 * the grid it measured, so these times are already musical and need no
 * correction before being drawn or played.
 */
export async function analyzeChords(file: File, signal?: AbortSignal): Promise<Chord[]> {
  const form = new FormData();
  form.append("file", file, file.name);
  const resp = await fetch(chordApi("/analyze"), { method: "POST", body: form, signal });
  if (!resp.ok) throw new Error(`the chord service answered ${resp.status}`);
  const body = (await resp.json()) as { chords?: unknown };
  return normalizeChords(body.chords);
}

/** Take only the fields the app uses, and coerce them. This response crosses an
 *  origin boundary from a separately deployed service, so it is the one place a
 *  version skew could hand us something unexpected. */
function normalizeChords(raw: unknown): Chord[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const c = (item ?? {}) as Record<string, unknown>;
    return {
      time: Number(c.time) || 0,
      label: String(c.label ?? ""),
      root: typeof c.root === "number" ? c.root : null,
      intervals: Array.isArray(c.intervals) ? c.intervals.map(Number) : [],
    };
  });
}

/** The chord sounding at `at` — the last change at or before it. */
export function chordAt(chords: Chord[], at: number): Chord | null {
  let found: Chord | null = null;
  for (const c of chords) {
    if (c.time > at) break;
    found = c;
  }
  return found;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
