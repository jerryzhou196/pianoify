import { muscriptorApi } from "./config";
import { assignFingers, assignHands } from "./hands";
import { TranscribeError, type TranscribeHandlers } from "./models";
import type { BeatGrid, Note, Transcription } from "./types";

/**
 * Transcription on the rented GPU box.
 *
 * One request, held open: `/transcribe` is a POST that answers with an SSE
 * stream, so the roll draws notes while the box is still decoding them. That
 * is the whole reason it is a stream and not a plain POST — the alternative
 * shows nothing until the last note is in.
 *
 * It is not called cross-origin. The box's CORS allowlist is a list of exact
 * origins and a Vercel preview URL is never on it, so the request goes to this
 * site's own `/gpu/*`, which `vercel.json` rewrites to the box at the edge and
 * `vite.config.ts` proxies in dev — the same trick the app already plays on
 * the yt-dlp service. Server-to-server, where CORS does not apply.
 *
 * Chords are not asked for here even though the box can recognize them: the
 * app has one chord source (the standalone service in `src/chords.ts`) and
 * having two would mean two chord tracks to reason about.
 */

/** The only instrument this app has.
 *
 *  `instruments` is a hard constraint, not a hint: the box masks out every
 *  program and drum token outside the listed groups during generation. Left
 *  unset, the model decodes whatever it hears — on a pop track that came back
 *  as 53% *drums*, and a drum event's "pitch" is a kit number (36 kick, 38
 *  snare, 42 hi-hat), so playing the stream on a piano meant literally playing
 *  the drum map as notes. Asking for piano gets the model's piano reduction of
 *  the track instead, which is the entire product. */
const INSTRUMENT = "acoustic_piano";

/** How long to keep re-trying a 503.
 *
 *  The deployed box queues concurrent requests rather than refusing them — it
 *  reports `queued` over the stream and gets there eventually. The retry stays
 *  because an older build answers 503 when busy instead, and a refusal there
 *  means "someone else is mid-transcription", not "broken". */
const BUSY_RETRY_MS = 5000;
const BUSY_ATTEMPTS = 12;

/** Slowest the roll is redrawn while notes stream in. Every closed note used
 *  to be its own React render; a busy passage closes dozens in a frame and
 *  none of them are individually worth a repaint. */
const DRAW_MS = 100;

export async function transcribe(
  file: File,
  handlers: TranscribeHandlers = {},
  signal?: AbortSignal,
): Promise<Transcription> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(file, handlers, signal);
    } catch (e) {
      const busy = e instanceof TranscribeError && e.status === 503;
      if (!busy || attempt >= BUSY_ATTEMPTS) throw e;
      handlers.onStage?.("queued");
      handlers.onProgress?.(null);
      await sleep(BUSY_RETRY_MS, signal);
    }
  }
}

/**
 * The stream is four kinds of event interleaved: queue and progress anchors,
 * `start` and `end` pairs that between them make a note, and one final
 * `transcription_complete` carrying the beat grid and the written MIDI.
 */
async function run(
  file: File,
  handlers: TranscribeHandlers,
  signal?: AbortSignal,
): Promise<Transcription> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("instruments", INSTRUMENT);
  form.append("detect_tempo", "best-effort");
  form.append("chords", "false");

  handlers.onStage?.("uploading");
  handlers.onProgress?.(null);

  const resp = await fetch(muscriptorApi("/transcribe"), {
    method: "POST",
    body: form,
    signal,
    headers: { "X-Client-Id": clientId() },
  });
  if (!resp.ok || !resp.body) {
    throw new TranscribeError(
      (await errorDetail(resp)) ?? `the gpu box answered ${resp.status}`,
      resp.status,
    );
  }

  handlers.onStage?.("queued");

  /** Open notes, keyed by the `index` their start event carried — which is what
   *  the matching end event names, since notes overlap and "the last one" would
   *  be the wrong answer for anything polyphonic. */
  const open = new Map<number, { midi: number; time: number }>();
  const notes: Note[] = [];
  let grid: BeatGrid | null = null;
  let onsetDelay = 0;
  let midi: string | null = null;
  let duration = 0;
  let started = false;
  let drawnAt = 0;

  const draw = (force: boolean) => {
    if (!handlers.onNotes) return;
    const now = performance.now();
    if (!force && now - drawnAt < DRAW_MS) return;
    drawnAt = now;
    handlers.onNotes(playable(notes));
  };

  for await (const ev of sseEvents(resp.body)) {
    switch (ev.type) {
      case "queued":
        // Re-sent every 15s as a heartbeat, which is also what keeps Cloudflare
        // from timing the connection out at 100s. `position` is how many runs
        // are ahead of this one; zero means it is next, not that it has begun.
        handlers.onStage?.(
          "queued",
          Number(ev.position) > 0 ? `${Number(ev.position)} ahead` : undefined,
        );
        break;

      case "transcription_started":
        started = true;
        handlers.onStage?.("transcribing");
        handlers.onProgress?.(null);
        break;

      case "progress": {
        // An older box streams notes without ever announcing the start.
        if (!started) {
          started = true;
          handlers.onStage?.("transcribing");
        }
        const total = Number(ev.total) || 0;
        handlers.onProgress?.(total > 0 ? Math.min(1, Number(ev.completed) / total) : null);
        break;
      }

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
        notes.push(note(start.midi, start.time, end));
        duration = Math.max(duration, end);
        draw(false);
        break;
      }

      case "transcription_complete": {
        const g = ev.beat_grid;
        if (g && Number(g.bpm) > 0) {
          grid = {
            bpm: Number(g.bpm),
            beatsPerBar: Number(g.beats_per_bar) || 4,
            firstDownbeat: Number(g.first_downbeat) || 0,
            // The box only sends a grid when it found one in the audio, so
            // there is no defaulted map to disbelieve the way Mirelo's has.
            detected: true,
          };
        }
        onsetDelay = Number(g?.onset_delay) || 0;
        midi = typeof ev.data === "string" ? ev.data : null;
        break;
      }
    }
  }

  // Anything still open never got its end event — the stream was cut short, or
  // the note ran past the clip. Close them at the clip's end so they are drawn
  // and played rather than silently dropped.
  for (const [, start] of open) notes.push(note(start.midi, start.time, duration));

  // The note times that streamed in sit `onset_delay` seconds late against the
  // detected beats (the box takes it out of the MIDI it writes, but not out of
  // the live events). Take it out here too, so the notes land on the same bar
  // lines the grid draws.
  if (onsetDelay) {
    for (const n of notes) n.time = Math.max(0, n.time - onsetDelay);
    duration = Math.max(0, duration - onsetDelay);
  }

  return {
    notes: playable(notes),
    grid,
    // The box has one way of reporting times and no say in the matter, so
    // there is never anything for the caption to report a fallback from.
    timing: { requested: "performance", applied: "performance", fallbackReason: null },
    duration,
    midiUrl: midi ? midiObjectUrl(midi) : null,
    // No engraver on the box. The sheet-music tab stays disabled, which is
    // what its own `disabled` already says when there is no MusicXML.
    musicxmlUrl: null,
  };
}

/** One note, with the fields the roll and the engine want but the stream does
 *  not carry. Hand and finger are placeholders until `playable` infers them. */
function note(midi: number, time: number, end: number): Note {
  return {
    midi,
    time,
    // A zero-length note is a decode artifact, not music; give it enough to be
    // visible and audible rather than dropping it.
    dur: Math.max(0.05, end - time),
    vel: 0.85,
    hand: "R",
    finger: 3,
  };
}

/** A copy of `notes` in playing order, voiced, and with hands and fingering
 *  worked out. Copied because this runs on a partial transcription too, and
 *  the array it is given goes on collecting notes afterwards. */
function playable(notes: Note[]): Note[] {
  const out = notes.map((n) => ({ ...n }));
  out.sort((a, b) => a.time - b.time || a.midi - b.midi);
  shapeDynamics(out);
  assignHands(out);
  assignFingers(out);
  return out;
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

/** The written MIDI, as something the export button can fetch.
 *
 *  It arrives base64 in the last event rather than behind a link, so there is
 *  no URL to hand over until one is made here. `App.tsx` revokes it when the
 *  next transcription replaces it. */
function midiObjectUrl(base64: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
  } catch {
    // A truncated or malformed payload. The notes are still good; only the
    // export button has nothing to point at.
    return null;
  }
}

/* ── plumbing ────────────────────────────────────────────────────────────── */

/** The client id scopes preemption on the box: a second upload only cancels an
 *  in-flight one carrying the *same* id, so a resubmit from this tab stops its
 *  own run and someone else's tab is left alone. Persisted, because a reload
 *  should still count as this same client. */
function clientId(): string {
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
