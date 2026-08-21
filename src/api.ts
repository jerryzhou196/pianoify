import { chordApi, chordServiceEnabled, transcribeApi } from "./config";
import type { BeatGrid, Chord, Note, Transcription } from "./types";

/** A `/transcribe` request that never produced a stream. `userMessage`, when
 *  set, is the server's own explanation (FastAPI's `{"detail": …}`) and is safe
 *  to put in front of a person — "could not decode audio file …" says more than
 *  "HTTP 400" ever will. */
export class TranscribeError extends Error {
  readonly userMessage?: string;
  readonly status?: number;
  constructor(message: string, opts: { userMessage?: string; status?: number } = {}) {
    super(message);
    this.name = "TranscribeError";
    this.userMessage = opts.userMessage;
    this.status = opts.status;
  }
}

/** Progress and partial results, reported as they stream in. The roll draws
 *  notes while the GPU is still working, which is most of why this is an SSE
 *  endpoint and not a plain POST. */
export interface TranscribeHandlers {
  /** The box runs one transcription at a time and queues the rest; `position`
   *  is how many are ahead. Re-sent every 15s as a heartbeat, which is also
   *  what keeps Cloudflare from timing the connection out at 100s. */
  onQueued?: (position: number) => void;
  /** This request reached the front of the queue — the GPU is now on it. */
  onStarted?: () => void;
  onProgress?: (completed: number, total: number) => void;
  onNotes?: (notes: Note[]) => void;
}

/** The client id scopes preemption on the server: a second upload only cancels
 *  an in-flight one carrying the *same* id, so a resubmit from this tab stops
 *  its own run and someone else's tab is left alone. Persisted, because a
 *  reload should still count as this same client. */
export function clientId(): string {
  const KEY = "pianoify-client-id";
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    // Private mode, or storage disabled. A per-session id still scopes
    // preemption correctly for as long as the tab is open.
    return crypto.randomUUID();
  }
}

/** FastAPI's `{"detail": "..."}`, when the failing response carries one. */
async function errorDetail(resp: Response): Promise<string | undefined> {
  try {
    const body = await resp.json();
    if (body && typeof body.detail === "string") return body.detail;
  } catch {
    // Not JSON, or the body was already consumed.
  }
  return undefined;
}

/** How long to keep re-trying a 503.
 *
 *  The deployed server queues concurrent requests rather than refusing them —
 *  a busy box reports `queued` over the stream and gets there eventually. The
 *  retry stays because an older build (and the checked-in source) answers 503
 *  when busy instead, and a refusal there means "someone else is mid-
 *  transcription", not "broken". */
const BUSY_RETRY_MS = 5000;
const BUSY_ATTEMPTS = 12;

/**
 * The only instrument this app has.
 *
 * `instruments` is a hard constraint, not a hint: the server masks out every
 * program and drum token outside the listed groups during generation. Left
 * unset, the model decodes whatever it hears — on a pop track that came back
 * as 53% *drums*, and a drum event's "pitch" is a kit number (36 kick, 38
 * snare, 42 hi-hat), so playing the stream on a piano meant literally playing
 * the drum map as notes. That is what a low-register mudslide sounds like.
 *
 * Asking for piano gets the model's piano reduction of the track instead —
 * which is the entire product — and decodes faster for having fewer tokens to
 * choose between.
 */
const INSTRUMENT = "acoustic_piano";

/**
 * Transcribe `file`, streaming notes as they arrive.
 *
 * The stream is three kinds of event interleaved: `progress` anchors, `start`
 * and `end` pairs that between them make a note, and one final
 * `transcription_complete` carrying the beat grid and the chord track. Notes
 * are reported through `onNotes` as they close, and the whole thing is
 * returned once the final event lands.
 */
export async function transcribe(
  file: File,
  handlers: TranscribeHandlers = {},
  signal?: AbortSignal,
): Promise<Transcription> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runTranscribe(file, handlers, signal);
    } catch (e) {
      const busy = e instanceof TranscribeError && e.status === 503;
      if (!busy || attempt >= BUSY_ATTEMPTS) throw e;
      await sleep(BUSY_RETRY_MS, signal);
    }
  }
}

async function runTranscribe(
  file: File,
  handlers: TranscribeHandlers,
  signal?: AbortSignal,
): Promise<Transcription> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("instruments", INSTRUMENT);
  form.append("detect_tempo", "best-effort");
  // Chords are asked for even when the standalone service is configured: it is
  // the cheaper source when the Space is asleep, and having both lets the
  // caller keep whichever answered.
  form.append("chords", "true");

  const resp = await fetch(transcribeApi("/transcribe"), {
    method: "POST",
    body: form,
    signal,
    headers: { "X-Client-Id": clientId() },
  });
  if (!resp.ok || !resp.body) {
    throw new TranscribeError(`server returned ${resp.status}`, {
      userMessage: await errorDetail(resp),
      status: resp.status,
    });
  }

  /** Open notes, keyed by the `index` their start event carried — which is what
   *  the matching end event names, since notes overlap and "the last one" would
   *  be the wrong answer for anything polyphonic. */
  const open = new Map<number, { midi: number; time: number }>();
  const notes: Note[] = [];
  let chords: Chord[] = [];
  let grid: BeatGrid | null = null;
  let duration = 0;

  for await (const ev of sseEvents(resp.body)) {
    switch (ev.type) {
      case "queued":
        handlers.onQueued?.(Number(ev.position) || 0);
        break;

      case "transcription_started":
        handlers.onStarted?.();
        break;

      case "progress":
        handlers.onProgress?.(Number(ev.completed) || 0, Number(ev.total) || 0);
        break;

      case "start":
        open.set(Number(ev.index), {
          midi: Number(ev.pitch),
          time: Number(ev.start_time),
        });
        break;

      case "end": {
        const start = open.get(Number(ev.start_event_index));
        if (!start) break;
        open.delete(Number(ev.start_event_index));
        const end = Number(ev.end_time);
        notes.push({
          midi: start.midi,
          time: start.time,
          // A zero-length note is a decode artifact, not music; give it enough
          // to be visible and audible rather than dropping it.
          dur: Math.max(0.05, end - start.time),
          vel: 0.85,
        });
        duration = Math.max(duration, end);
        handlers.onNotes?.(notes.slice());
        break;
      }

      case "transcription_complete": {
        const g = ev.beat_grid;
        if (g) {
          grid = {
            bpm: Number(g.bpm),
            beatsPerBar: Number(g.beats_per_bar) || 4,
            firstDownbeat: Number(g.first_downbeat) || 0,
            onsetDelay: g.onset_delay == null ? null : Number(g.onset_delay),
          };
        }
        chords = normalizeChords(ev.chords);
        break;
      }
    }
  }

  // Anything still open never got its end event — the stream was cut short, or
  // the note ran past the clip. Close them at the clip's end so they are drawn
  // and played rather than silently dropped.
  for (const [, start] of open) {
    notes.push({
      midi: start.midi,
      time: start.time,
      dur: Math.max(0.05, duration - start.time),
      vel: 0.85,
    });
  }

  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  shapeDynamics(notes);

  // The note times that streamed in sit `onset_delay` seconds late against the
  // detected beats (the server takes it out of the MIDI it writes, but not out
  // of the live events). Take it out here too, so the notes land on the same
  // bar lines the grid draws and on the chord changes, which were snapped to
  // those beats already.
  const delay = grid?.onsetDelay ?? 0;
  if (delay) {
    for (const n of notes) n.time = Math.max(0, n.time - delay);
  }

  return { notes, chords, grid, duration };
}

/**
 * Give the notes dynamics, because the stream has none.
 *
 * Every event comes back at the same fixed velocity — the model transcribes
 * pitch and time, not touch. Playing that literally sounds like a music box, so
 * simultaneities get shaped the way a pianist would voice them: the bass note
 * and the top line carry, the inner voices sit back. It is invented, and it is
 * the difference between a chord and a cluster.
 */
function shapeDynamics(notes: Note[]): void {
  const CHORD_WINDOW = 0.04;
  for (let i = 0; i < notes.length; ) {
    let j = i;
    while (j < notes.length && notes[j].time - notes[i].time < CHORD_WINDOW) j++;
    const group = notes.slice(i, j).sort((a, b) => a.midi - b.midi);
    group.forEach((n, k) => {
      const isBass = k === 0;
      const isTop = k === group.length - 1;
      n.vel = isBass ? 0.92 : isTop ? 0.86 : 0.62;
      // Low notes carry further on a real piano than the synth's fixed
      // amplitude suggests; ease them back so the bass doesn't swamp the line.
      if (n.midi < 48) n.vel *= 0.88;
    });
    i = j;
  }
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

/** Yield the JSON payload of each `data:` line in an SSE body.
 *
 *  Hand-parsed rather than handed to `EventSource`, which can only GET — and
 *  the audio has to be POSTed. Decoding is streaming (`{ stream: true }`), so a
 *  chunk boundary that lands mid-character doesn't corrupt the text. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) yield JSON.parse(line.slice(6));
      }
    }
  }
}

/* ── chord service ───────────────────────────────────────────────────────── */

const WARM_ATTEMPTS = 4;
const WARM_RETRY_MS = 6000;

/**
 * Ping the chord Space's `/health` so it is awake by the time a file is picked.
 *
 * A free Space is stopped when idle and takes tens of seconds to come back; the
 * first request pays for that boot. Sending it while the user is still choosing
 * a file usually hides the whole wake-up. It reports `"loading"` while its model
 * is still coming up, which is worth another ping — a request sent then would
 * only queue behind the load.
 *
 * Never throws and never surfaces anything: chords are an extra, and a sleeping
 * chord service must not look like a broken app.
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
 * Recognize the chords in `file` with the standalone BTC service.
 *
 * `detect_tempo` is left at the service's `best-effort` default: when it finds
 * a beat grid the chord boundaries snap to it, and the times that come back are
 * already grid-aligned — so, like the chords `/transcribe` sends, they need no
 * `onset_delay` correction before being drawn or played.
 */
export async function analyzeChords(
  file: File,
  signal?: AbortSignal,
): Promise<Chord[]> {
  const form = new FormData();
  form.append("file", file, file.name);
  const resp = await fetch(chordApi("/analyze"), {
    method: "POST",
    body: form,
    signal,
  });
  if (!resp.ok) throw new Error((await errorDetail(resp)) ?? `HTTP ${resp.status}`);
  const body = (await resp.json()) as { chords?: unknown };
  return normalizeChords(body.chords);
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
