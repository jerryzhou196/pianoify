/**
 * What can transcribe a clip, and the vocabulary every transcriber speaks.
 *
 * There are two backends, and the picker in the header is where you choose
 * between them:
 *
 *   **Mirelo** is a hosted API. It bills credits, it is reached through this
 *   site's own `/api/*` functions (see `src/mirelo.ts`), and it engraves as it
 *   transcribes: the MusicXML behind the sheet-music tab comes back with the
 *   notes.
 *
 *   **MuScriptor** is the rented GPU box. It costs nothing per clip because
 *   the instance is already paid for by the hour, it streams notes as it
 *   decodes them, and it engraves on a second request — MuseScore, on the
 *   box's CPU, a few seconds after the roll is already playing.
 *
 * The types below are shared rather than per-backend so that `App.tsx` can
 * hold one set of handlers and hand it to whichever of the two the picker
 * names. Both clients import *this* module rather than each other, which is
 * what keeps that from being a cycle; the only things it imports are a type
 * and a number, neither of which imports back.
 */

import { MAX_CLIP_SECONDS } from "./config";
import type { Note } from "./types";

/** How Mirelo should write note times. Not a MuScriptor choice — the box
 *  reports what it heard and nothing else. */
export type TimingMode = "performance" | "quantized";

/** What the transcribing overlay is currently saying. */
export type Stage = "uploading" | "queued" | "transcribing" | "engraving";

export interface TranscribeHandlers {
  /** `detail` is anything worth putting after the stage — the queue position,
   *  when there is a queue and this clip is not at the front of it. */
  onStage?: (stage: Stage, detail?: string) => void;
  /** 0–1 through whatever the current stage is, or null when the stage has no
   *  measurable progress. */
  onProgress?: (fraction: number | null) => void;
  /** Notes decoded so far. Called only while the job is still running — the
   *  finished set comes back from the promise. */
  onNotes?: (notes: Note[]) => void;
}

/** A transcription that failed somewhere we can explain. `message` is the
 *  backend's own wording where it had one, which is almost always better than
 *  ours: "could not decode audio" says more than "HTTP 400" ever will. */
export class TranscribeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TranscribeError";
  }
}

export type ModelId = "mirelo-performance" | "mirelo-quantized" | "muscriptor";

export interface Model {
  id: ModelId;
  /** Which client runs this one. */
  backend: "mirelo" | "muscriptor";
  /** Named in the stage line: "queued at mirelo", "queued on the gpu box". */
  service: string;
  name: string;
  tag: string;
  note: string;
  /** Mirelo only, and required there: what to ask for in the job. */
  timing?: TimingMode;
  /** Whether picking this one spends Mirelo credits — which is what decides
   *  if the modal quotes a price before the button. */
  billed: boolean;
  /** The longest clip this one takes, in seconds, or null for no limit.
   *
   *  It is the trim handles' stop, so it is a property of the model rather
   *  than of the app: the two backends disagree about it, and they disagree
   *  for the reason they differ about everything else. Mirelo bills by the
   *  second and refuses anything past ten minutes; the box is rented by the
   *  hour, transcribes in five-second chunks it streams as it goes, and has
   *  no length it will not take — only one it will take a while over. */
  maxSeconds: number | null;
}

/**
 * The model menu, in the order it is offered — the box first, because it is
 * what the picker opens on: it costs nothing per clip, so it is the one to
 * reach for unless the sheet music is the point.
 *
 * Two of the three are the same Mirelo model asked for different note times:
 * it publishes one audio-to-MIDI model (v1.0) and one meaningful choice about
 * how it reports its results. `quantized` is a request rather than an
 * instruction — the server honours it only when the beat grid it detected is
 * steady enough to move notes onto, and says so in `timing.applied` when it
 * isn't. The third is the box.
 */
export const MODELS: Model[] = [
  {
    id: "muscriptor",
    backend: "muscriptor",
    service: "the gpu box",
    name: "MuScriptor · GPU box",
    tag: "self-hosted",
    note: "Runs on the rented GPU rather than a hosted API: no credits, no length limit, and the notes appear on the roll as the box decodes them. The sheet music is engraved a few seconds behind them.",
    billed: false,
    maxSeconds: null,
  },
  {
    id: "mirelo-performance",
    backend: "mirelo",
    service: "mirelo",
    name: "Mirelo v1.0 · performance",
    tag: "as played",
    note: "Keeps the take exactly as played, rubato and all, and describes its pacing with a tempo map.",
    timing: "performance",
    billed: true,
    maxSeconds: MAX_CLIP_SECONDS,
  },
  {
    id: "mirelo-quantized",
    backend: "mirelo",
    service: "mirelo",
    name: "Mirelo v1.0 · quantized",
    tag: "on the grid",
    note: "Snaps onsets to the detected beats — honoured only when that grid is steady enough to move notes onto.",
    timing: "quantized",
    billed: true,
    maxSeconds: MAX_CLIP_SECONDS,
  },
];

/** What the picker opens on. The first entry is the default, and is also what
 *  an id from an older build falls back to. */
export const DEFAULT_MODEL: ModelId = MODELS[0].id;

export const modelById = (id: ModelId): Model =>
  MODELS.find((m) => m.id === id) ?? MODELS[0];

export const modeLabel = (id: ModelId): string => modelById(id).name;
