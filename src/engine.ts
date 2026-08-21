import { SplendidGrandPiano, type Smplr, type StopFn } from "smplr";
import type { Note } from "./types";

/**
 * Playback for the transcription and the original recording.
 *
 * The piano side is a compact multisample rather than a bank of oscillators:
 * thirteen Steinway pitches at two touch levels, with the nearest recording
 * transposed by at most four semitones to cover all 88 keys. The samples are
 * public-domain Splendid Grand Piano recordings, loaded by `smplr` while the
 * upload panel is open. A short release leaves a little natural sustain after
 * each key comes up without washing one chord into the next.
 */

/** How far ahead of the clock notes are handed to WebAudio. Long enough that a
 * slow frame cannot make a note late, short enough that a seek has little
 * scheduled work to cancel. */
const HORIZON = 0.35;

/** The audible tail after a key release. */
const RELEASE_SECONDS = 0.42;

/** Sampled notes need a little more bus level than a mastered recording; the
 * limiter below catches the rare dense peak this extra gain creates. */
const TRANSCRIBED_GAIN = 1.5;

/** Sparse roots from the Splendid Grand Piano set. Adjacent roots are no more
 * than eight semitones apart, so every played note stays close to a recording. */
const SAMPLE_ROOTS = [23, 31, 38, 45, 52, 59, 67, 74, 81, 89, 97, 105, 107];
const SAMPLE_VELOCITY_RANGE: [number, number] = [68, 100];

interface Voice {
  stop: StopFn;
  readonly until: number;
}

export class Engine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private pianoBus!: GainNode;
  private originalBus!: GainNode;
  private piano!: Smplr;
  private pianoReady: Promise<void> | null = null;
  private pianoAvailable = false;
  /** Keeps a superseded development-mode preload from marking a newer piano
   * ready after Strict Mode has disposed and recreated the audio graph. */
  private pianoGeneration = 0;

  private notes: Note[] = [];
  private noteCursor = 0;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  private pumpTimer: number | null = null;
  /** Context time that corresponds to position 0 of the piece. */
  private origin = 0;
  private pausedAt = 0;
  private live: Voice[] = [];
  private voiceId = 0;
  /** Invalidates a play request that is waiting for the samples. */
  private playRequest = 0;

  /** 0 = original recording only, 1 = piano only. */
  private mix = 0.72;
  /** Playback speed. The recording is resampled, while piano samples retain
   * their written pitch and only their timing is stretched. */
  private rate = 1;
  duration = 0;
  playing = false;

  /* ── graph ─────────────────────────────────────────────────────────────── */

  /** Create the graph once and begin fetching the piano samples. The context
   * may remain suspended until a user gesture, but it can decode samples in
   * the meantime. */
  private audio(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.pianoAvailable = false;
    const generation = ++this.pianoGeneration;

    // A fast limiter catches the sum of dense sampled chords without turning
    // normal passages into compressed audio.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0.62;
    this.master.connect(limiter);

    this.pianoBus = ctx.createGain();
    this.pianoBus.connect(this.master);

    this.originalBus = ctx.createGain();
    this.originalBus.connect(this.master);

    this.piano = SplendidGrandPiano(ctx, {
      destination: this.pianoBus,
      decayTime: RELEASE_SECONDS,
      volume: 127,
      notesToLoad: {
        notes: SAMPLE_ROOTS,
        velocityRange: SAMPLE_VELOCITY_RANGE,
      },
    });
    this.pianoReady = this.piano.ready.then(
      () => {
        if (generation === this.pianoGeneration) this.pianoAvailable = true;
      },
      (error) => {
        if (generation !== this.pianoGeneration) return;
        // Playback stays stopped if the sample host is unavailable. Logging
        // the original failure is more useful than a later missing-buffer
        // error for every scheduled note.
        console.error("could not load the sampled piano", error);
      },
    );

    this.applyMix();
    return ctx;
  }

  /** Start loading samples before playback is requested. */
  prepare(): void {
    this.audio();
  }

  /** Resume WebAudio and wait until all sample roots are decoded. `resume()`
   * is called before the first await so it remains inside the user gesture. */
  async unlock(): Promise<void> {
    const ctx = this.audio();
    const resumed = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
    await Promise.all([resumed, this.pianoReady]);
  }

  private applyMix() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Without a decoded recording there is nothing to fade against, so the
    // piano goes to full rather than sitting at whatever the slider says.
    const piano = (this.buffer ? this.mix : 1) * TRANSCRIBED_GAIN;
    const original = this.buffer ? 1 - this.mix : 0;
    this.pianoBus.gain.setTargetAtTime(piano, t, 0.02);
    this.originalBus.gain.setTargetAtTime(original, t, 0.02);
  }

  setMix(mix: number) {
    this.mix = Math.max(0, Math.min(1, mix));
    this.applyMix();
  }

  /* ── material ──────────────────────────────────────────────────────────── */

  /** Replace the transcription. Safe mid-playback: the cursor is re-seeked,
   * so notes that stream in while the roll is moving get picked up. */
  setNotes(notes: Note[], duration: number) {
    this.notes = notes;
    this.duration = Math.max(duration, this.buffer?.duration ?? 0);
    if (this.playing) this.reseek();
  }

  /** Hand over the decoded clip so it can be crossfaded against the piano. */
  setOriginal(buffer: AudioBuffer | null) {
    this.buffer = buffer;
    if (buffer) this.duration = Math.max(this.duration, buffer.duration);
    this.applyMix();
  }

  /* ── transport ─────────────────────────────────────────────────────────── */

  get position(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    return Math.max(0, (this.ctx.currentTime - this.origin) * this.rate);
  }

  /** Context time a piece-time position falls at. */
  private clockTime(position: number): number {
    return this.origin + position / this.rate;
  }

  /** Change playback speed while keeping the current position. */
  setSpeed(rate: number) {
    const next = Math.max(0.25, Math.min(2, rate));
    if (next === this.rate) return;
    if (!this.playing) {
      this.rate = next;
      return;
    }
    const at = this.position;
    this.silence();
    this.rate = next;
    this.origin = this.audio().currentTime - at / this.rate + 0.08;
    this.reseek();
    this.startOriginal();
    this.pump();
  }

  async play(): Promise<void> {
    if (this.playing) return;
    const request = ++this.playRequest;
    const ctx = this.audio();
    await this.unlock();
    if (request !== this.playRequest || this.playing || !this.pianoAvailable) return;

    // Starting from the very end is a replay, not a no-op.
    if (this.pausedAt >= this.duration - 0.05) this.pausedAt = 0;
    this.origin = ctx.currentTime - this.pausedAt / this.rate + 0.08;
    this.playing = true;
    this.reseek();
    this.startOriginal();
    this.pumpTimer = window.setInterval(() => this.pump(), 50);
    this.pump();
  }

  pause() {
    this.playRequest++;
    if (!this.playing) return;
    this.pausedAt = Math.min(this.position, this.duration);
    this.playing = false;
    this.stopTimers();
    this.silence();
  }

  seek(seconds: number) {
    const to = Math.max(0, Math.min(seconds, this.duration));
    if (this.playing) {
      this.silence();
      this.origin = this.audio().currentTime - to / this.rate + 0.08;
      this.reseek();
      this.startOriginal();
      this.pump();
    } else {
      this.pausedAt = to;
    }
  }

  /** Sound one sampled key outside the transport. */
  async strike(midi: number, dur = 0.9): Promise<void> {
    const ctx = this.audio();
    await this.unlock();
    if (!this.pianoAvailable) return;
    this.spawn(midi, ctx.currentTime + 0.005, dur, 0.9);
  }

  /** Release everything and drop the context. */
  dispose() {
    this.playRequest++;
    this.pianoGeneration++;
    this.pianoAvailable = false;
    this.stopTimers();
    this.silence();
    this.piano?.dispose();
    void this.ctx?.close();
    this.ctx = null;
    this.playing = false;
  }

  private stopTimers() {
    if (this.pumpTimer !== null) clearInterval(this.pumpTimer);
    this.pumpTimer = null;
  }

  /** Stop every sampled voice and the original recording on pause or seek. */
  private silence() {
    const now = this.ctx?.currentTime ?? 0;
    for (const voice of this.live) voice.stop(now);
    this.live = [];
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // Already stopped at the end of its buffer.
      }
      this.source = null;
    }
  }

  /** Move the note cursor to the current position. */
  private reseek() {
    const at = this.position;
    this.noteCursor = 0;
    while (this.noteCursor < this.notes.length && this.notes[this.noteCursor].time < at) {
      this.noteCursor++;
    }
  }

  private startOriginal() {
    if (!this.buffer) return;
    const ctx = this.audio();
    const offset = this.position;
    if (offset >= this.buffer.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.originalBus);
    // Resampling, not time-stretching: slower recording playback drops pitch;
    // the separately triggered piano samples retain their written pitches.
    src.playbackRate.value = this.rate;
    src.start(this.clockTime(offset), offset);
    this.source = src;
  }

  /** Hand WebAudio every note beginning inside the scheduling horizon. */
  private pump() {
    if (!this.playing || !this.ctx) return;
    const ctx = this.ctx;
    const until = ctx.currentTime + HORIZON;

    while (this.noteCursor < this.notes.length) {
      const note = this.notes[this.noteCursor];
      const at = this.clockTime(note.time);
      if (at >= until) break;
      this.noteCursor++;
      this.spawn(
        note.midi,
        Math.max(ctx.currentTime, at),
        note.dur / this.rate,
        note.vel,
      );
    }

    const now = ctx.currentTime;
    this.live = this.live.filter((voice) => voice.until > now);

    // Leave enough room for the final sample release before resetting.
    if (this.position > this.duration + RELEASE_SECONDS + 0.4) {
      this.pause();
      this.pausedAt = 0;
    }
  }

  /** Trigger the nearest real recording and let its release envelope provide
   * the small amount of sustain. */
  private spawn(midi: number, at: number, dur: number, velocity: number): void {
    const sounding = Math.max(0.05, dur);
    const stop = this.piano.start({
      note: midi,
      time: at,
      duration: sounding,
      velocity: sampleVelocity(velocity),
      ampRelease: RELEASE_SECONDS,
      stopId: ++this.voiceId,
    });
    this.live.push({ stop, until: at + sounding + RELEASE_SECONDS });
    this.cap();
  }

  /** Bound simultaneous sample voices during dense overlapping passages. */
  private cap() {
    const MAX_VOICES = 96;
    if (this.live.length <= MAX_VOICES) return;
    const now = this.audio().currentTime;
    for (const voice of this.live.splice(0, this.live.length - MAX_VOICES)) {
      voice.stop(now);
    }
  }
}

/** Keep note events inside the two loaded touch layers while preserving the
 * transcription's relative dynamics. */
function sampleVelocity(velocity: number): number {
  const normalized = Math.max(0, Math.min(1, velocity));
  const [low, high] = SAMPLE_VELOCITY_RANGE;
  return Math.round(low + normalized * (high - low));
}
