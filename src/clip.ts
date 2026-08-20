import { CLIP_SECONDS } from "./config";

/** The slice of a file that actually gets uploaded, plus the decoded audio for
 *  that same slice so playback and transcription are looking at the same
 *  seconds. `offset` is where in the original file the clip starts — shown in
 *  the header, so it is obvious the app didn't just take the first 15s. */
export interface Clip {
  /** Uploadable 16-bit PCM WAV of the chosen window. */
  file: File;
  /** The same window, decoded, for the "original" side of the mix. */
  buffer: AudioBuffer;
  offset: number;
  duration: number;
}

/** Analysis frame length. ~46ms at 44.1k: short enough to see a rest, long
 *  enough that one quiet moment inside a held note doesn't read as silence. */
const FRAME = 2048;

/** Decode `file` and cut the most musical `CLIP_SECONDS` out of it.
 *
 *  Throws when the browser can't decode the file at all, and when the file
 *  turns out to be silent end to end — there is no window worth sending then,
 *  and the transcriber would spend a GPU minute confirming it. */
export async function makeClip(file: File): Promise<Clip> {
  const bytes = await file.arrayBuffer();
  // A plain AudioContext, not OfflineAudioContext: decodeAudioData on an
  // offline context resamples to that context's rate, and we want the file's
  // own rate — the server is happier resampling once, from the original.
  const ac = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ac.decodeAudioData(bytes);
  } finally {
    void ac.close();
  }

  const mono = toMono(decoded);
  const sr = decoded.sampleRate;
  const want = Math.min(Math.round(CLIP_SECONDS * sr), mono.length);
  const start = pickWindow(mono, want, sr);

  const buffer = sliceBuffer(decoded, start, want);
  const wav = encodeWav(mono.subarray(start, start + want), sr);
  const name = file.name.replace(/\.[^.]+$/, "") + ".wav";
  return {
    file: new File([wav], name, { type: "audio/wav" }),
    buffer,
    offset: start / sr,
    duration: want / sr,
  };
}

/** Average the channels down to one. Transcription is monophonic input anyway,
 *  and it halves what goes over the wire. */
function toMono(buf: AudioBuffer): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  const chans = buf.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / chans;
  }
  return out;
}

/**
 * Choose where the clip starts.
 *
 * Loudest-window would do the obvious wrong thing on a track with one big
 * chorus hit and would happily straddle a long rest as long as the peak was
 * high enough. What we actually want is the window with the most *playing* in
 * it, so the score is the count of frames above a noise floor first, and mean
 * loudness only as the tie-break — which is what separates two equally busy
 * windows and picks the one with something to transcribe.
 *
 * Both terms come off the same prefix sums, so the whole search is linear in
 * the number of frames no matter how long the file is.
 */
function pickWindow(mono: Float32Array, want: number, sr: number): number {
  const frames = Math.floor(mono.length / FRAME);
  if (frames < 2 || want >= mono.length) {
    if (!hasSignal(mono)) throw new SilentAudioError();
    return 0;
  }

  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const off = f * FRAME;
    for (let i = 0; i < FRAME; i++) sum += mono[off + i] * mono[off + i];
    rms[f] = Math.sqrt(sum / FRAME);
  }

  // The floor is relative to the file, not absolute: a quiet solo-piano
  // recording and a mastered pop track disagree by 30dB about what "quiet"
  // means, and only the file itself knows which one it is.
  const loud = percentile(rms, 0.95);
  if (loud < 1e-4) throw new SilentAudioError();
  const floor = Math.max(loud * 0.06, 1e-5);

  const active = new Float64Array(frames + 1);
  const energy = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) {
    active[f + 1] = active[f] + (rms[f] > floor ? 1 : 0);
    energy[f + 1] = energy[f] + rms[f];
  }

  const win = Math.max(1, Math.floor(want / FRAME));
  if (win >= frames) return 0;
  let bestStart = 0;
  let best = -Infinity;
  for (let f = 0; f + win <= frames; f++) {
    const a = (active[f + win] - active[f]) / win;
    const e = (energy[f + win] - energy[f]) / win / loud;
    const score = a + 0.25 * Math.min(1, e);
    // `>` not `>=`: on a file where every window scores the same (a steady
    // loop), the earliest one is the least surprising thing to hand back.
    if (score > best) {
      best = score;
      bestStart = f;
    }
  }
  if (best <= 0) throw new SilentAudioError();

  // Nudge back to the last frame that was quiet, so the clip opens on an
  // attack instead of halfway through whatever note was already ringing.
  let s = bestStart;
  while (s > 0 && s > bestStart - Math.floor(sr * 0.25 / FRAME) && rms[s - 1] > floor) s--;

  return Math.min(s * FRAME, mono.length - want);
}

export class SilentAudioError extends Error {
  constructor() {
    super("that file is silent all the way through");
    this.name = "SilentAudioError";
  }
}

function hasSignal(mono: Float32Array): boolean {
  for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > 1e-4) return true;
  return false;
}

/** `p`-quantile of `values`, via a copy — the caller still needs the original
 *  in frame order. */
function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function sliceBuffer(src: AudioBuffer, start: number, len: number): AudioBuffer {
  const out = new AudioBuffer({
    length: len,
    numberOfChannels: src.numberOfChannels,
    sampleRate: src.sampleRate,
  });
  for (let c = 0; c < src.numberOfChannels; c++) {
    out.copyToChannel(src.getChannelData(c).subarray(start, start + len), c);
  }
  return out;
}

/** Mono 16-bit PCM WAV. The server reads WAV through the stdlib `wave` module
 *  before it ever reaches libsndfile, which is the decode path its own CLI
 *  uses — so sending WAV means the bytes it transcribes are the bytes we
 *  played back, with no second decoder in between to disagree. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
