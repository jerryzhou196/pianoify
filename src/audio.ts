import { CLIP_SECONDS } from "./config";

/**
 * Everything that happens to a file before it is a transcription: decoding it,
 * drawing it, choosing which part of it to send, and cutting that part out as
 * something Mirelo will accept.
 *
 * The trim handles in the upload modal are the reason this is a module and not
 * a function. The old flow picked a window silently; this one opens the handles
 * on the same choice and then lets you disagree with it, which means the
 * decode, the waveform and the cut all have to be separately available.
 */

/** A decoded file, ready to be cropped. */
export interface Source {
  /** Shown in the header, and the stem of the name the crop is uploaded under. */
  name: string;
  /** Every channel, for playing the original back in stereo. */
  buffer: AudioBuffer;
  /** The channels averaged into one, for analysis and for upload. */
  mono: Float32Array;
  sampleRate: number;
  duration: number;
  /** Bar heights for the waveform, 0–1. */
  peaks: Float32Array;
}

/** How many bars the waveform is drawn with. Enough that a phrase has a shape,
 *  few enough that each bar is still a pixel or two wide at modal width. */
const PEAK_COUNT = 200;

/** Analysis frame length. ~46ms at 44.1k: short enough to see a rest, long
 *  enough that one quiet moment inside a held note doesn't read as silence. */
const FRAME = 2048;

export class SilentAudioError extends Error {
  constructor() {
    super("that file is silent all the way through");
    this.name = "SilentAudioError";
  }
}

/** Decode `file` into something the modal can draw and cut.
 *
 *  Throws when the browser cannot decode the file at all, and when the file is
 *  silent end to end — there is no crop worth paying credits for then. */
export async function decodeSource(file: File): Promise<Source> {
  const bytes = await file.arrayBuffer();
  // A plain AudioContext, not OfflineAudioContext: decodeAudioData on an
  // offline context resamples to that context's rate, and we want the file's
  // own rate — one resample, at Mirelo's end, from the original.
  const ac = new AudioContext();
  let buffer: AudioBuffer;
  try {
    buffer = await ac.decodeAudioData(bytes);
  } finally {
    void ac.close();
  }

  const mono = toMono(buffer);
  if (!hasSignal(mono)) throw new SilentAudioError();

  return {
    name: file.name.replace(/\.[^.]+$/, ""),
    buffer,
    mono,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
    peaks: peaksOf(mono),
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

function hasSignal(mono: Float32Array): boolean {
  for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > 1e-4) return true;
  return false;
}

/** Peak amplitude per bar, normalized so the loudest bar is full height. Peak
 *  rather than RMS: a waveform is read for where the *hits* are, and RMS
 *  flattens exactly that. */
function peaksOf(mono: Float32Array): Float32Array {
  const out = new Float32Array(PEAK_COUNT);
  const per = Math.max(1, Math.floor(mono.length / PEAK_COUNT));
  let loudest = 0;
  for (let i = 0; i < PEAK_COUNT; i++) {
    const start = i * per;
    let peak = 0;
    for (let j = start; j < Math.min(start + per, mono.length); j++) {
      const v = Math.abs(mono[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > loudest) loudest = peak;
  }
  if (loudest > 0) for (let i = 0; i < PEAK_COUNT; i++) out[i] = out[i] / loudest;
  return out;
}

/** Seconds into the file, as a fraction of it — the unit the trim handles work
 *  in, so the modal never has to convert. */
export interface Crop {
  /** 0–1 of the source duration. */
  a: number;
  b: number;
}

/**
 * Where to open the trim handles: the first ten seconds that are not silence.
 *
 * Not the loudest window, and not the busiest one. Either would be a guess
 * about which part of a recording is worth hearing, and a guess that lands
 * somewhere in the middle of a track is a guess you have to check before you
 * can trust it. The first thing you played is the thing you are most likely to
 * have meant, it is where you would have dragged the handles yourself, and it
 * is the one answer that needs no explaining. Everything else is a drag away.
 *
 * "Not silence" is file-relative, because a quiet solo-piano recording and a
 * mastered pop track disagree by 30dB about what quiet means. The floor is a
 * fraction of the file's own loud passages, and the window opens at the first
 * run of frames above it that lasts long enough to be a sound rather than a
 * click on the tape.
 */
export function suggestCrop(source: Source, seconds = CLIP_SECONDS): Crop {
  const { mono, sampleRate, duration } = source;
  const want = Math.min(seconds * sampleRate, mono.length);
  const frames = Math.floor(mono.length / FRAME);
  if (frames < 2 || want >= mono.length) return { a: 0, b: 1 };

  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const off = f * FRAME;
    for (let i = 0; i < FRAME; i++) sum += mono[off + i] * mono[off + i];
    rms[f] = Math.sqrt(sum / FRAME);
  }

  const loud = percentile(rms, 0.95);
  // Nothing anywhere near loud: `decodeSource` has already refused true
  // silence, so this is a whole file at a whisper. Start at the top.
  const floor = loud < 1e-4 ? 0 : Math.max(loud * 0.06, 1e-5);

  // Three consecutive frames — about 140ms at 44.1k. One frame over the floor
  // is a click, a pop, or the room; three is something being played.
  const RUN = 3;
  let start = 0;
  let run = 0;
  for (let f = 0; f < frames; f++) {
    if (rms[f] > floor) {
      run++;
      if (run >= RUN) {
        start = f - (RUN - 1);
        break;
      }
    } else {
      run = 0;
    }
  }

  // Back off one frame so the window opens just before the attack rather than
  // a hair inside it, which would clip the onset of the first note.
  const startSec = Math.max(0, ((start - 1) * FRAME) / sampleRate);
  const end = Math.min(duration, startSec + want / sampleRate);
  return { a: Math.min(startSec, Math.max(0, duration - want / sampleRate)) / duration, b: end / duration };
}

/** The crop, as seconds. */
export function cropSeconds(source: Source, crop: Crop): { start: number; end: number } {
  const start = Math.max(0, crop.a * source.duration);
  const end = Math.min(source.duration, crop.b * source.duration);
  return { start, end };
}

/** The crop, decoded, for the "original" side of the crossfade. Every channel,
 *  because this one is listened to rather than analysed. */
export function cropBuffer(source: Source, crop: Crop): AudioBuffer {
  const { start, end } = cropSeconds(source, crop);
  const from = Math.floor(start * source.sampleRate);
  const len = Math.max(1, Math.floor((end - start) * source.sampleRate));
  const out = new AudioBuffer({
    length: len,
    numberOfChannels: source.buffer.numberOfChannels,
    sampleRate: source.sampleRate,
  });
  for (let c = 0; c < source.buffer.numberOfChannels; c++) {
    out.copyToChannel(source.buffer.getChannelData(c).subarray(from, from + len), c);
  }
  return out;
}

/** The crop, as an uploadable mono 16-bit WAV. WAV rather than the original
 *  file: it is what the crop *is* after being cut, it needs no second decoder
 *  at the far end to disagree with this one, and the bytes transcribed are then
 *  exactly the bytes played back. */
export function cropToWav(source: Source, crop: Crop): File {
  const { start, end } = cropSeconds(source, crop);
  const from = Math.floor(start * source.sampleRate);
  const len = Math.max(1, Math.floor((end - start) * source.sampleRate));
  const wav = encodeWav(source.mono.subarray(from, from + len), source.sampleRate);
  return new File([wav], `${source.name}.wav`, { type: "audio/wav" });
}

/** `p`-quantile of `values`, via a copy — the caller still needs the original
 *  in frame order. */
function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

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
