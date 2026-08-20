import { hz } from "./roll";
import type { BeatGrid, Chord, Note } from "./types";

/**
 * The piano.
 *
 * Everything here is synthesized rather than sampled, on purpose: a sampled
 * grand means a ~38MB soundfont over the wire before the first note sounds,
 * and this page's whole promise is that you drop a file in and hear it back.
 * What a synthesized piano usually gets wrong is not the tone, it is the
 * *decay* — one exponential per note, no dampers, no pedal — which is exactly
 * what makes a transcription sound like a music box. So the decay is where the
 * work went:
 *
 *   - each note is a stack of inharmonic partials, each with its own decay
 *     rate, so the tone thins as it rings instead of fading uniformly;
 *   - a damper falls when the key is released — unless the pedal is down, in
 *     which case the string rings on until the pedal comes up at the next
 *     chord change, the way a pianist re-pedals on the harmony;
 *   - the strings that aren't damped are fed a little of everything else
 *     through a soundboard, which is what a pedalled piano actually sounds
 *     like and what a per-note envelope can never produce.
 */

/** How far ahead of the clock notes are handed to WebAudio. Long enough that a
 *  slow frame can't make a note late, short enough that a seek doesn't have to
 *  unpick much. */
const HORIZON = 0.35;

export type Pedal = "off" | "on";

/** Seconds a damper takes to stop a string. Felt on wire is quick, but not
 *  instant — an abrupt cut sounds like a gate, not a piano. */
const DAMP_TIME = 0.16;

/** How much soundboard the pedal opens up. With the dampers down the other
 *  strings are dead and there is nothing to resonate. */
const RESONANCE: Record<Pedal, number> = { off: 0.05, on: 0.28 };

interface Voice {
  stop(at: number, damp: number): void;
  /** When every partial has gone quiet on its own, so the scheduler can forget
   *  about a voice it will never have to damp. */
  readonly until: number;
}

export class Engine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private pianoBus!: GainNode;
  private chordBus!: GainNode;
  private originalBus!: GainNode;
  private boardSend!: GainNode;

  private notes: Note[] = [];
  private chordNotes: Note[] = [];
  private noteCursor = 0;
  private chordCursor = 0;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  private pumpTimer: number | null = null;
  /** Context time that corresponds to position 0 of the piece. */
  private origin = 0;
  private pausedAt = 0;
  private live: Voice[] = [];

  private pedal: Pedal = "on";
  /** Times the pedal comes up, with the dampers landing on everything still
   *  ringing. See `setChords` and `nextLift`. */
  private lifts: number[] = [];
  private grid: BeatGrid | null = null;
  /** 0 = original recording only, 1 = piano only. */
  private mix = 0.72;
  private chordsOn = false;
  duration = 0;
  playing = false;

  /* ── graph ─────────────────────────────────────────────────────────────── */

  /** The AudioContext, created on first use. Browsers hand out a suspended one
   *  outside a gesture, so this is safe to call from anywhere; `resume()` is
   *  what needs the click. */
  private audio(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    this.ctx = ctx;

    // A limiter across the output, and headroom in front of it.
    //
    // A piano with the pedal down is an additive instrument: sixty ringing
    // strings sum, and a dense passage measured well past full scale before
    // this was here. Setting the gain low enough that the worst case never
    // clips would make everything else too quiet, so instead there is a fast,
    // high-ratio limiter that only ever engages on the peaks — and enough
    // headroom in front of it that it stays out of the way the rest of the
    // time, rather than compressing the life out of every note.
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

    // The soundboard: one shared convolver every ringing string leaks into.
    // Per-note reverb would be wrong as well as expensive — the resonance of a
    // pedalled piano is the *other* strings answering, so it has to be shared.
    const board = ctx.createConvolver();
    board.buffer = soundboardImpulse(ctx);
    const boardOut = ctx.createGain();
    boardOut.gain.value = 1;
    board.connect(boardOut);
    boardOut.connect(this.master);
    this.boardSend = ctx.createGain();
    this.boardSend.connect(board);

    this.pianoBus = ctx.createGain();
    this.pianoBus.connect(this.master);
    this.pianoBus.connect(this.boardSend);

    // Chords comp *under* the transcription, so they get their own trim rather
    // than relying on every chord voice being written quieter.
    this.chordBus = ctx.createGain();
    this.chordBus.gain.value = 0.34;
    this.chordBus.connect(this.master);
    this.chordBus.connect(this.boardSend);

    this.originalBus = ctx.createGain();
    this.originalBus.connect(this.master);

    this.applyMix();
    this.applyPedal();
    return ctx;
  }

  /** Resume the context. Must be called from inside a user gesture. */
  async unlock(): Promise<void> {
    const ctx = this.audio();
    if (ctx.state === "suspended") await ctx.resume();
  }

  private applyMix() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Without a decoded recording there is nothing to fade against, so the
    // piano goes to full rather than sitting at whatever the slider says.
    const piano = this.buffer ? this.mix : 1;
    const original = this.buffer ? 1 - this.mix : 0;
    this.pianoBus.gain.setTargetAtTime(piano, t, 0.02);
    this.chordBus.gain.setTargetAtTime(piano * 0.34 * (this.chordsOn ? 1 : 0), t, 0.02);
    this.originalBus.gain.setTargetAtTime(original, t, 0.02);
  }

  private applyPedal() {
    if (!this.ctx) return;
    this.boardSend.gain.setTargetAtTime(
      RESONANCE[this.pedal],
      this.ctx.currentTime,
      0.05,
    );
  }

  setMix(mix: number) {
    this.mix = Math.max(0, Math.min(1, mix));
    this.applyMix();
  }

  /** Change pedal position. Notes already sounding keep the damping they were
   *  scheduled with — lifting the pedal mid-note would have to re-damp every
   *  live voice, and the honest version of that is to hear it from the next
   *  note on, which is also what a real pedal change sounds like on a roll
   *  that is already ringing. */
  setPedal(pedal: Pedal) {
    this.pedal = pedal;
    this.applyPedal();
  }

  setChordsEnabled(on: boolean) {
    this.chordsOn = on;
    this.applyMix();
  }

  /* ── material ──────────────────────────────────────────────────────────── */

  /** The detected tempo map, used to re-pedal on the bar when there is no
   *  chord track to re-pedal on instead. */
  setGrid(grid: BeatGrid | null) {
    this.grid = grid;
  }

  /** Replace the transcription. Safe mid-playback: the cursor is re-seeked, so
   *  notes that stream in while the roll is already rolling get picked up. */
  setNotes(notes: Note[], duration: number) {
    this.notes = notes;
    this.duration = Math.max(duration, this.buffer?.duration ?? 0);
    if (this.playing) this.reseek();
  }

  /** Voice the chord track as a sustained pad: each chord is held until the
   *  next one starts. `root` and `intervals` come straight off the recognizer,
   *  so no music theory is needed here — `48 + root + interval` puts the chord
   *  just below middle C, which is where a comping hand sits, and root position
   *  throughout keeps it from lurching an octave whenever the root crosses B. */
  setChords(chords: Chord[]) {
    const out: Note[] = [];
    for (let i = 0; i < chords.length; i++) {
      const { time, root, intervals } = chords[i];
      // An "N.C." span carries no root: nothing is scheduled, which is exactly
      // how the chord before it gets to stop.
      if (root === null || !intervals.length) continue;
      const end = i + 1 < chords.length ? chords[i + 1].time : this.duration || time + 4;
      if (end <= time) continue;
      for (const semis of intervals) {
        out.push({ midi: 48 + root + semis, time, dur: end - time, vel: 0.5 });
      }
    }
    out.sort((a, b) => a.time - b.time);
    this.chordNotes = out;
    // Every chord change is also a pedal change. A pianist does not hold the
    // damper pedal down for fifteen seconds; they re-pedal on the harmony,
    // which is the only thing that lets a pedalled passage stay pedalled
    // without turning into a chord of everything played so far. With no chord
    // track there is nothing to re-pedal against, and the strings ring free.
    this.lifts = chords.map((c) => c.time).filter((t) => t > 0);
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
    return Math.max(0, this.ctx.currentTime - this.origin);
  }

  play() {
    if (this.playing) return;
    const ctx = this.audio();
    void this.unlock();
    // Starting from the very end is a replay, not a no-op — otherwise `play`
    // does nothing at all once a clip has run out.
    if (this.pausedAt >= this.duration - 0.05) this.pausedAt = 0;
    // A beat of headroom so the first notes are scheduled ahead of the clock
    // rather than fired the instant they are seen.
    this.origin = ctx.currentTime - this.pausedAt + 0.08;
    this.playing = true;
    this.reseek();
    this.startOriginal();
    this.pumpTimer = window.setInterval(() => this.pump(), 50);
    this.pump();
  }

  pause() {
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
      this.origin = this.audio().currentTime - to + 0.08;
      this.reseek();
      this.startOriginal();
      this.pump();
    } else {
      this.pausedAt = to;
    }
  }

  /** Sound a single note now — the keyboard's click handler. Nothing to do
   *  with the transport, so it works while stopped, and it is deliberately
   *  exempt from the pedal lifts: those belong to the piece's timeline, and a
   *  key pressed by hand is not on it. Pressing a key with the pedal down and
   *  hearing it ring is the whole point of having the control. */
  strike(midi: number, dur = 0.9) {
    const ctx = this.audio();
    void this.unlock();
    this.spawn(midi, ctx.currentTime + 0.005, dur, 0.9, this.pianoBus, false, true);
  }

  /** Release everything and drop the context. */
  dispose() {
    this.stopTimers();
    this.silence();
    void this.ctx?.close();
    this.ctx = null;
    this.playing = false;
  }

  private stopTimers() {
    if (this.pumpTimer !== null) clearInterval(this.pumpTimer);
    this.pumpTimer = null;
  }

  /** Cut every ringing string and stop the recording. Used on pause and seek,
   *  where letting the old notes ring on over the new position would be wrong
   *  however pretty it sounds. */
  private silence() {
    const now = this.ctx?.currentTime ?? 0;
    for (const v of this.live) v.stop(now, 0.06);
    this.live = [];
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // Already stopped — a source that ran to its end throws here.
      }
      this.source = null;
    }
  }

  /** Move both cursors to the current position, so `pump` resumes from there
   *  instead of replaying the notes it has already handed out. */
  private reseek() {
    const at = this.position;
    this.noteCursor = 0;
    while (this.noteCursor < this.notes.length && this.notes[this.noteCursor].time < at) {
      this.noteCursor++;
    }
    this.chordCursor = 0;
    while (
      this.chordCursor < this.chordNotes.length &&
      this.chordNotes[this.chordCursor].time < at
    ) {
      this.chordCursor++;
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
    // (when, offset): the recording is placed against the same origin the notes
    // are, which is the only thing keeping the two in sync.
    src.start(this.origin + offset, offset);
    this.source = src;
  }

  /** Hand WebAudio everything that starts in the next `HORIZON` seconds. */
  private pump() {
    if (!this.playing || !this.ctx) return;
    const ctx = this.ctx;
    const until = ctx.currentTime + HORIZON;

    while (this.noteCursor < this.notes.length) {
      const n = this.notes[this.noteCursor];
      if (this.origin + n.time >= until) break;
      this.noteCursor++;
      this.spawn(n.midi, Math.max(ctx.currentTime, this.origin + n.time), n.dur, n.vel, this.pianoBus);
    }
    while (this.chordCursor < this.chordNotes.length) {
      const n = this.chordNotes[this.chordCursor];
      if (this.origin + n.time >= until) break;
      this.chordCursor++;
      this.spawn(
        n.midi,
        Math.max(ctx.currentTime, this.origin + n.time),
        n.dur,
        n.vel,
        this.chordBus,
        true,
      );
    }

    const now = ctx.currentTime;
    this.live = this.live.filter((v) => v.until > now);

    // Let the last notes ring out past the end of the clip before stopping —
    // cutting the transport at `duration` would chop the final chord.
    if (this.position > this.duration + 1.2) {
      this.pause();
      this.pausedAt = 0;
    }
  }

  /* ── voice ─────────────────────────────────────────────────────────────── */

  /**
   * One struck string.
   *
   * The partials are inharmonic — a real string is stiff, so its nth partial
   * sits above `n·f0` by a factor that grows with n. Without it an additive
   * stack sounds like an organ; with it, it sounds struck. Each partial also
   * decays faster than the one below it, which is what gives a piano its
   * characteristic thinning from a bright attack into a pure, slow tail.
   */
  private spawn(
    midi: number,
    at: number,
    dur: number,
    vel: number,
    bus: GainNode,
    soft = false,
    /** Ignore the pedal lifts — this note is not on the piece's timeline. */
    free = false,
  ): void {
    const ctx = this.audio();
    const f0 = hz(midi);
    const amp = (soft ? 0.5 : 1) * vel * gainFor(midi);

    const voice = ctx.createGain();
    voice.gain.value = 1;
    voice.connect(bus);

    // Seconds to inaudibility with nothing damping the string. Bass strings
    // are long and heavy and ring for the better part of a minute; the top
    // octave is over in a second or two. This single number is most of what
    // makes a synthesized piano read as a piano rather than an organ with a
    // fade-out, and the values are roughly what a real grand measures.
    const ring = 26 * Math.pow(2, -(midi - 21) / 22) + 0.5;
    // Fewer partials up top: above about 4kHz they are inaudible individually
    // and only cost CPU, and a high note has fewer of them to begin with.
    const count = midi < 52 ? 9 : midi < 72 ? 6 : 4;
    const B = 0.00008 * Math.pow(2, (midi - 60) / 16);

    let last = at;
    for (let n = 1; n <= count; n++) {
      const freq = f0 * n * Math.sqrt(1 + B * n * n);
      if (freq > ctx.sampleRate / 2.2) break;
      // 1/n² would be a plucked string; a hammer excites the low partials much
      // more strongly than that, and the softer the blow the more so.
      const level = amp * Math.pow(n, soft ? -2.1 : -1.55) * (n === 1 ? 1 : 0.85);
      const tau = (ring / Math.pow(n, 0.62)) * (soft ? 1.15 : 1);
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      // A hair of detune per partial: two strings per note on a real piano are
      // never in perfect unison, and that beating is most of the warmth.
      osc.detune.value = (n - 1) * (Math.random() * 2 - 1) * 1.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      // Higher partials speak a moment later than the fundamental — the hammer
      // takes time to leave the string.
      const attack = soft ? 0.05 : 0.004 + n * 0.0012;
      g.gain.linearRampToValueAtTime(level, at + attack);
      const end = at + attack + tau;
      g.gain.exponentialRampToValueAtTime(level * 0.001, end);
      osc.connect(g);
      g.connect(voice);
      osc.start(at);
      osc.stop(end + 0.05);
      last = Math.max(last, end);
    }

    if (!soft) this.hammer(voice, at, midi, vel);

    // The damper.
    //
    // With the pedal up it falls when the key is released, and the note lasts
    // as long as the transcription says the key was held. With the pedal down
    // the key release does nothing at all and the string keeps ringing — until
    // the next pedal lift, which is the next chord change. That is what makes
    // this a pedal rather than just a long release: notes bleed across the
    // harmony they belong to and stop at its edge.
    const release = at + Math.max(0.05, dur);
    const held = this.pedal === "on";
    const cut = held ? (free ? Infinity : this.nextLift(release)) : release;
    const stop = (when: number, over: number) => {
      const t = Math.max(ctx.currentTime, when);
      voice.gain.cancelScheduledValues(t);
      voice.gain.setValueAtTime(voice.gain.value, t);
      voice.gain.exponentialRampToValueAtTime(0.0001, t + over);
    };
    if (cut < last) stop(cut, DAMP_TIME);

    const until = Math.min(last, cut + DAMP_TIME);
    this.live.push({ until, stop });
    this.cap();
  }

  /**
   * Context time of the first pedal lift after `after`.
   *
   * Nobody holds a damper pedal down for fifteen seconds. A pianist re-takes
   * it constantly, and *where* they re-take it is the musical judgement: on
   * the harmony if there is one, otherwise on the bar, and failing both at
   * roughly the rate a moderate tempo would suggest. All three are the same
   * idea — the pedal is periodically lifted, and everything still ringing is
   * damped when it is — which is what keeps a pedalled passage pedalled
   * instead of accumulating into a chord of the whole piece.
   *
   * Past the last lift it returns a time beyond the clip, so the closing
   * chord rings out on its own rather than being cut off.
   */
  private nextLift(after: number): number {
    // A hair of slack: a note struck exactly on the change belongs to the
    // chord it opens, not to the one it just ended.
    const at = after - this.origin + 0.02;
    if (this.lifts.length) {
      for (const t of this.lifts) if (t > at) return this.origin + t;
      return this.origin + this.duration + 8;
    }
    const bar =
      this.grid && this.grid.bpm > 0
        ? (60 / this.grid.bpm) * (this.grid.beatsPerBar || 4)
        : 2;
    const phase = this.grid?.firstDownbeat ?? 0;
    return this.origin + phase + (Math.floor((at - phase) / bar) + 1) * bar;
  }

  /** Ceiling on simultaneous ringing strings.
   *
   *  A real piano has 88 and a pedalled passage genuinely uses most of them,
   *  but each one here is a handful of oscillators, and a dense transcription
   *  with the pedal down can stack faster than they retire. Past the cap the
   *  oldest voices are damped early — the same thing that happens acoustically
   *  when the first notes of a pedalled run have faded under the later ones. */
  private cap() {
    const MAX = 120;
    if (this.live.length <= MAX) return;
    const now = this.audio().currentTime;
    for (const v of this.live.splice(0, this.live.length - MAX)) v.stop(now, 0.25);
  }

  /** The knock of felt on wire — a few milliseconds of filtered noise. Without
   *  it every note starts out of nowhere; with it, something hits something. */
  private hammer(dest: GainNode, at: number, midi: number, vel: number) {
    const ctx = this.audio();
    const len = Math.floor(ctx.sampleRate * 0.012);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = Math.min(6000, hz(midi) * 5);
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.05 * vel * gainFor(midi);
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(at);
  }
}

/** Equal-loudness trim. The ear is far less sensitive down low, but a bass
 *  note also has far more energy in its partials, so the two do not cancel —
 *  left flat, the bass swamps everything. */
function gainFor(midi: number): number {
  return midi < 48 ? 0.2 : midi < 72 ? 0.15 : 0.11;
}

/**
 * The soundboard, as a short impulse response.
 *
 * Noise shaped by an exponential decay, with the very start left quiet — a
 * soundboard answers a fraction of a beat after the string, not with it. It is
 * not a room: at ~1.1s and mixed low it reads as the body of the instrument,
 * which is the point. Anything longer starts sounding like a hall.
 */
function soundboardImpulse(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 1.1);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Ramp in over the first 8ms so the dry signal isn't just doubled.
      const onset = Math.min(1, i / (ctx.sampleRate * 0.008));
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.8) * onset * 0.6;
    }
  }
  return buf;
}
