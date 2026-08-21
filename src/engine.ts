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
 *
 * The transport repeats. A clip is a handful of seconds and hearing it once is
 * rarely enough, so the end of a pass runs into the top of the next one rather
 * than into silence; the seam is scheduled before it arrives, and the last
 * chord's release rings over the first notes coming back round.
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
  /** Every pass of the recording handed to WebAudio and not yet finished —
   *  two of them across a seam, because the next pass is scheduled while the
   *  current one is still sounding. */
  private sources: AudioBufferSourceNode[] = [];

  private pumpTimer: number | null = null;
  /** Context time that corresponds to position 0 of the first pass. Passes are
   *  exactly one `duration` apart, so this is not rewritten every time round —
   *  `lapOrigin` counts forward from it instead. */
  private origin = 0;
  /** Context time of position 0 for the pass the note cursor is walking. That
   *  is the pass now sounding, until the seam falls inside the scheduling
   *  horizon and the cursor moves on to the next one. */
  private scheduleOrigin = 0;
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
    return Math.max(0, (this.ctx.currentTime - this.lapOrigin()) * this.rate);
  }

  /** Context time the pass now sounding began at. Derived rather than stored,
   *  so the position the roll and the clock read wraps on the frame the seam
   *  is crossed instead of on the next fifty-millisecond pump. */
  private lapOrigin(): number {
    if (!this.ctx || this.duration <= 0) return this.origin;
    const lap = this.duration / this.rate;
    const passes = Math.floor((this.ctx.currentTime - this.origin) / lap);
    return passes > 0 ? this.origin + passes * lap : this.origin;
  }

  /** Context time a piece-time position falls at, in the pass now sounding. */
  private clockTime(position: number): number {
    return this.lapOrigin() + position / this.rate;
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

  /** Stop every sampled voice and the original recording on pause or seek.
   *  Both passes go across a seam, including one that has been scheduled but
   *  has not begun. */
  private silence() {
    const now = this.ctx?.currentTime ?? 0;
    for (const voice of this.live) voice.stop(now);
    this.live = [];
    for (const src of this.sources.splice(0)) {
      try {
        src.stop();
      } catch {
        // Already stopped at the end of its buffer.
      }
    }
  }

  /** Move the note cursor to the current position, in the pass now sounding. */
  private reseek() {
    const at = this.position;
    this.scheduleOrigin = this.lapOrigin();
    this.noteCursor = 0;
    while (this.noteCursor < this.notes.length && this.notes[this.noteCursor].time < at) {
      this.noteCursor++;
    }
  }

  /** Play the recording from `offset` seconds into the piece, starting at
   *  `when` in context time. The defaults are where the transport is now; the
   *  seam passes the top of the next pass and the moment it begins, which is
   *  still a fraction of a second away. */
  private startOriginal(offset = this.position, when = this.clockTime(offset)) {
    if (!this.buffer) return;
    const ctx = this.audio();
    if (offset >= this.buffer.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.originalBus);
    // Resampling, not time-stretching: slower recording playback drops pitch;
    // the separately triggered piano samples retain their written pitches.
    src.playbackRate.value = this.rate;
    src.onended = () => {
      this.sources = this.sources.filter((other) => other !== src);
    };
    src.start(when, offset);
    this.sources.push(src);
  }

  /** Hand WebAudio every note beginning inside the scheduling horizon. The
   *  horizon can reach past the end of a pass, in which case the cursor rolls
   *  round to the top of the next one and keeps going: the notes either side
   *  of a seam are scheduled in the same breath, so nothing about it has to
   *  happen on time later. */
  private pump() {
    if (!this.playing || !this.ctx) return;
    const ctx = this.ctx;
    const until = ctx.currentTime + HORIZON;
    const lap = this.duration > 0 ? this.duration / this.rate : 0;

    // One turn per pass. Anything longer than a third of a second crosses at
    // most one seam per pump; the bound is only there so a degenerate clip
    // cannot schedule passes forever.
    for (let crossed = 0; crossed < 4; crossed++) {
      while (this.noteCursor < this.notes.length) {
        const note = this.notes[this.noteCursor];
        const at = this.scheduleOrigin + note.time / this.rate;
        if (at >= until) break;
        this.noteCursor++;
        this.spawn(
          note.midi,
          Math.max(ctx.currentTime, at),
          note.dur / this.rate,
          note.vel,
        );
      }

      const next = this.scheduleOrigin + lap;
      if (lap <= 0 || next >= until) break;
      this.scheduleOrigin = next;
      this.noteCursor = 0;
      this.startOriginal(0, next);
    }

    const now = ctx.currentTime;
    this.live = this.live.filter((voice) => voice.until > now);
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
