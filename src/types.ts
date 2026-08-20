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
  beatsPerBar: number;
  firstDownbeat: number;
  /** Seconds the streamed note onsets sit *late* against the beats. The MIDI
   *  the server returns already has this taken out; notes drawn from the live
   *  event stream have not, so the roll subtracts it once the grid arrives. */
  onsetDelay: number | null;
}

export interface Transcription {
  notes: Note[];
  chords: Chord[];
  grid: BeatGrid | null;
  /** Length of the clip that was sent, in seconds. */
  duration: number;
}
