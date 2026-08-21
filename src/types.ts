/** Which hand plays a note. Assigned by `src/hands.ts` — Mirelo transcribes
 *  pitch and time, not who played what. */
export type Hand = "L" | "R";

/** A transcribed note, in the shape the roll draws and the engine plays. */
export interface Note {
  /** MIDI note number. */
  midi: number;
  /** Onset, seconds into the clip. */
  time: number;
  /** Sounding length in seconds — before the pedal extends it. */
  dur: number;
  /** 0–1. Drives both the roll's opacity and the voice's amplitude. */
  vel: number;
  /** Which hand this was given to, and which finger of it. Both are inferred,
   *  and both are what the roll colours and numbers a note by. */
  hand: Hand;
  finger: number;
}

/** One recognized chord change. `root`/`intervals` are what the chord is made
 *  of, so the engine can voice it without knowing any music theory; both are
 *  empty for an "N.C." span, which says the harmony stopped rather than that
 *  nothing was heard. */
export interface Chord {
  time: number;
  label: string;
  root: number | null;
  intervals: number[];
}

/** The detected tempo map. Null when no tempo was found, in which case the
 *  roll falls back to a plain seconds grid. */
export interface BeatGrid {
  bpm: number;
  /** Null when a tempo was found but no meter — the beats are steady and
   *  nobody could say where the bar starts. Reported rather than defaulted to
   *  four, so that nothing claims a time signature the transcriber did not. */
  beatsPerBar: number | null;
  firstDownbeat: number;
  /** Whether Mirelo measured this from the audio or fell back to its default
   *  120/4. A defaulted grid is not worth drawing bar lines from. */
  detected: boolean;
}

/** How note times were written. `requested` is what the model picker asked for;
 *  `applied` is what came back — `quantized` is honoured only when the detected
 *  beat grid is steady enough to move notes onto, and `fallbackReason` says why
 *  when it was not. */
export interface Timing {
  requested: string;
  applied: string;
  fallbackReason: string | null;
}

export interface Transcription {
  notes: Note[];
  grid: BeatGrid | null;
  timing: Timing;
  /** Length of the clip that was sent, in seconds. */
  duration: number;
  /** The transcriber's own renderings of the same transcription. Both are what
   *  the export buttons hand over, and the MusicXML is what the sheet-music tab
   *  engraves. Mirelo returns presigned links that expire in an hour; the GPU
   *  box hands back MIDI bytes, which become an object URL. */
  midiUrl: string | null;
  musicxmlUrl: string | null;
  /** Engrave what was just decoded, when the MusicXML did not come back with
   *  it. The GPU box sets this — it writes notation on request, in a second
   *  call of a few seconds, so the sheet music lands after the roll rather
   *  than holding it up. Null from the call means the engraving failed, which
   *  costs the sheet-music tab and never the transcription. */
  engrave?: () => Promise<Engraving | null>;
}

/** Notation written after the notes, and what it was written from.
 *
 *  `quantized` says the engraving came from a copy of the transcription with
 *  its onsets moved onto the detected beats. The roll still draws the notes as
 *  they were played, so when this is true the two are deliberately showing
 *  different things — which is why the sheet-music caption says so. */
export interface Engraving {
  url: string;
  quantized: boolean;
}
