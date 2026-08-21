import { assignFingers, assignHands } from "./hands";
import { TranscribeError, type TimingMode, type TranscribeHandlers } from "./models";
import type { BeatGrid, Note, Timing, Transcription } from "./types";

/**
 * Transcription on Mirelo's hosted API — one of the two the picker offers,
 * and the only one that engraves. The other is the GPU box in
 * `src/muscriptor.ts`; both speak the vocabulary in `src/models.ts`.
 *
 * Two hops, neither of which carries the API key:
 *
 *   1. `/api/asset` takes the crop itself, measures it, refuses it if it runs
 *      past ten seconds, and uploads it to Mirelo's storage. The clip could go
 *      straight from the tab to a presigned S3 URL instead — but then nothing
 *      between here and Mirelo would ever see how long it is, and the cap has
 *      to hold somewhere the browser cannot reach around. Ten seconds of mono
 *      PCM is under a megabyte, so the detour costs nothing.
 *   2. `/api/job` starts the transcription and is then polled. Mirelo's async
 *      endpoint reports `progress_percent` and hands back the notes decoded so
 *      far, which is what fills the roll in while the model is still working.
 *
 * The alternative — one long `/sync` call — would hold a serverless function
 * open for about 1.5× the length of the audio and show nothing until it
 * returned. Two minutes of piano is three minutes of blank screen, and past
 * about three minutes it is a platform timeout as well.
 */

/** How often to ask how the job is going. Mirelo's own guidance is 1–2s, and
 *  the roll gains a visible batch of notes about that often. */
const POLL_MS = 1200;

/** Give up on a job that never reaches a terminal state. Ten minutes is far
 *  past the estimate for any crop this app will send. */
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export async function transcribe(
  file: File,
  timing: TimingMode,
  handlers: TranscribeHandlers = {},
  signal?: AbortSignal,
): Promise<Transcription> {
  handlers.onStage?.("uploading");
  handlers.onProgress?.(0);

  const slot = await upload(file, (fraction) => handlers.onProgress?.(fraction), signal);

  handlers.onStage?.("queued");
  handlers.onProgress?.(null);
  const job = await api<{ job_id: string; estimated_ms: number | null }>("/api/job", {
    method: "POST",
    body: { asset_id: slot.asset_id, timing },
    signal,
  });

  return await poll(job.job_id, handlers, signal);
}

/** Ask what a crop of this length will cost before committing to it. Returns
 *  null rather than throwing: a quote that did not arrive is a missing line of
 *  small print, not a reason to stop someone transcribing. */
export async function quote(
  durationSeconds: number,
  signal?: AbortSignal,
): Promise<{ credits: number | null; estimated_ms: number | null } | null> {
  try {
    return await api(`/api/preflight?duration_ms=${Math.round(durationSeconds * 1000)}`, {
      signal,
    });
  } catch {
    return null;
  }
}

/* ── the job ─────────────────────────────────────────────────────────────── */

async function poll(
  id: string,
  handlers: TranscribeHandlers,
  signal?: AbortSignal,
): Promise<Transcription> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let announced = false;

  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const payload = await api<any>(`/api/job?id=${encodeURIComponent(id)}`, { signal });
    const status = String(payload.status ?? "");

    if (status === "succeeded") {
      const result = payload.result ?? {};
      return {
        notes: readNotes(result.notes),
        grid: readGrid(result),
        timing: readTiming(result),
        duration: Number(result.duration_seconds) || 0,
        midiUrl: typeof result.midi_url === "string" ? result.midi_url : null,
        musicxmlUrl: typeof result.musicxml_url === "string" ? result.musicxml_url : null,
      };
    }
    if (status === "errored" || status === "failed" || status === "cancelled") {
      throw new TranscribeError(
        payload.error?.message ?? payload.error ?? "the transcriber could not read that audio",
      );
    }

    // Still running. The first payload that carries anything at all is the
    // moment the model is actually on it rather than waiting to be.
    const partial = payload.result?.notes ?? payload.notes;
    const percent = Number(payload.progress_percent);
    if (!announced && (Array.isArray(partial) || Number.isFinite(percent))) {
      announced = true;
      handlers.onStage?.("transcribing");
    }
    handlers.onProgress?.(Number.isFinite(percent) ? Math.max(0, Math.min(1, percent / 100)) : null);
    if (Array.isArray(partial) && partial.length) handlers.onNotes?.(readNotes(partial));

    if (Date.now() > deadline) {
      throw new TranscribeError("that transcription is taking longer than ten minutes — giving up");
    }
    await sleep(POLL_MS, signal);
  }
}

/* ── reading Mirelo's shapes ─────────────────────────────────────────────── */

/** Mirelo's notes, in the shape the roll and the engine want.
 *
 *  Hands and fingering are added here rather than left to the caller because
 *  every consumer needs them and neither is cheap enough to recompute per
 *  frame. Both are inferred — see `src/hands.ts`. */
function readNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  const notes: Note[] = [];
  for (const item of raw) {
    const n = (item ?? {}) as Record<string, unknown>;
    const midi = Math.round(Number(n.pitch));
    const time = Number(n.start);
    const end = Number(n.end);
    if (!Number.isFinite(midi) || !Number.isFinite(time)) continue;
    notes.push({
      midi,
      time: Math.max(0, time),
      // A zero-length note is a decode artifact, not music; give it enough to
      // be visible and audible rather than dropping it.
      dur: Math.max(0.05, (Number.isFinite(end) ? end : time) - time),
      vel: clampVel(Number(n.velocity)),
      hand: "R",
      finger: 3,
    });
  }
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  shapeDynamics(notes);
  assignHands(notes);
  assignFingers(notes);
  return notes;
}

function clampVel(velocity: number): number {
  if (!Number.isFinite(velocity)) return 0.8;
  return Math.max(0.05, Math.min(1, velocity / 127));
}

/**
 * Give the notes dynamics when the transcription has none.
 *
 * Mirelo returns a velocity per note, but on plenty of material every one of
 * them is the same number — the model transcribed pitch and time, not touch.
 * Played literally that sounds like a music box, so a flat transcription gets
 * its simultaneities voiced the way a pianist would: the bass note and the top
 * line carry, the inner voices sit back. A transcription that *did* come back
 * with real dynamics is left exactly as it is.
 */
function shapeDynamics(notes: Note[]): void {
  if (notes.length < 2) return;
  const first = notes[0].vel;
  if (notes.some((n) => Math.abs(n.vel - first) > 0.01)) return;

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

/** The tempo map, or null when Mirelo did not find one.
 *
 *  `tempo_source` is the field that matters: it reads `default` when nothing
 *  was detected and the 120/4 in the payload is a placeholder. Drawing bar
 *  lines from a placeholder would be inventing a grid, so a defaulted map is
 *  reported as no map at all. */
function readGrid(result: any): BeatGrid | null {
  const g = result?.time_grid;
  if (!g) return null;
  const bpm = Number(g.tempo_bpm ?? result.tempo_bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const detected = g.tempo_source === "detected";
  const beatsPerBar = Number(g.beats_per_bar) || 4;
  const pickup = Number(g.pickup_beats) || 0;
  return {
    bpm,
    beatsPerBar,
    // A pickup is how many beats of the first bar are missing, so the first
    // full downbeat is that far in.
    firstDownbeat: pickup > 0 ? (pickup * 60) / bpm : 0,
    detected,
  };
}

function readTiming(result: any): Timing {
  const t = result?.timing ?? {};
  return {
    requested: String(t.requested ?? "performance"),
    applied: String(t.applied ?? "performance"),
    fallbackReason: typeof t.fallback_reason === "string" ? t.fallback_reason : null,
  };
}

/* ── plumbing ────────────────────────────────────────────────────────────── */

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const resp = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new TranscribeError(body?.error ?? `${path} answered ${resp.status}`, resp.status);
  }
  return body as T;
}

/** Send the crop to `/api/asset`, reporting how much of it has gone.
 *
 *  XHR rather than `fetch`: upload progress is the one thing `fetch` still
 *  cannot report. Under a megabyte this is usually instant, but on a bad
 *  connection it is the only part of the wait that has a number attached. */
function upload(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ asset_id: string; seconds: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/asset");
    xhr.setRequestHeader("Content-Type", "audio/wav");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: a proxy or platform error page.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.asset_id) {
        onProgress(1);
        resolve(body);
      } else {
        reject(new TranscribeError(body?.error ?? `the upload was refused (${xhr.status})`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new TranscribeError("the upload could not reach the server"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
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
