import type { Hand } from "./types";

/** The whole keyboard, A0–C8. The design draws all 88 keys, so a bass note
 *  that lands below C2 has somewhere real to go instead of being folded up an
 *  octave into the middle of the texture. */
export const LOW = 21;
export const HIGH = 108;

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
export const isBlack = (midi: number) => BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12);

/** Where a key sits, as a percentage of the keyboard's width. Blacks overhang
 *  the boundary between their neighbours, which is why `left` can be less than
 *  the white key's — they are drawn on top, in a later layer. */
export interface KeyGeometry {
  left: number;
  width: number;
  black: boolean;
}

function buildKeyMap(): { map: Record<number, KeyGeometry>; whiteWidth: number } {
  let whites = 0;
  for (let m = LOW; m <= HIGH; m++) if (!isBlack(m)) whites++;
  const w = 100 / whites;
  const map: Record<number, KeyGeometry> = {};
  let wi = 0;
  for (let m = LOW; m <= HIGH; m++) {
    if (isBlack(m)) {
      map[m] = { left: wi * w - w * 0.31, width: w * 0.62, black: true };
    } else {
      map[m] = { left: wi * w, width: w, black: false };
      wi++;
    }
  }
  return { map, whiteWidth: w };
}

/** Built once — the keyboard's span never changes, and every note style asks
 *  for it. */
export const { map: KEY_MAP, whiteWidth: WHITE_WIDTH } = buildKeyMap();

/** All 88 keys, low to high, for the keyboard to draw. */
export const KEYS: number[] = Array.from({ length: HIGH - LOW + 1 }, (_, i) => LOW + i);

/** Geometry for a note that may be off the drawn range: fold it into the
 *  nearest octave inside A0–C8 rather than dropping it. Almost never fires now
 *  that the whole keyboard is drawn, but a transcription is free to return a
 *  pitch outside it and the roll must still place the note somewhere. */
export function keyFor(midi: number): { geo: KeyGeometry; midi: number } {
  let m = midi;
  while (m < LOW) m += 12;
  while (m > HIGH) m -= 12;
  return { geo: KEY_MAP[m], midi: m };
}

/* ── colour ──────────────────────────────────────────────────────────────── */

/** Five shades a hand, darkening toward the bass. A single flat colour per
 *  hand reads as a wall on a dense passage; graded by register, the roll shows
 *  the shape of the writing — where the left hand sits, how high the line
 *  climbs — before you have read a single note. */
const GREENS = [[15, 95, 67], [23, 121, 90], [34, 154, 113], [47, 187, 135], [61, 220, 151]];
const BLUES = [[43, 87, 135], [55, 111, 172], [69, 137, 214], [90, 162, 242], [120, 188, 255]];

/** `rgb(r,g,b)` for a note. Left hand green, right hand blue — the same two
 *  hues the transcribed/original crossfade runs between, so the slider reads as
 *  a fade between the piano and the recording rather than as an unrelated
 *  control. */
export function noteColor(hand: Hand, midi: number): string {
  const ramp = hand === "L" ? GREENS : BLUES;
  const step = Math.max(0, Math.min(4, Math.floor((midi - 33) / 15)));
  return `rgb(${ramp[step].join(",")})`;
}

/** The same colour, with an alpha — used to fade the transcription out as the
 *  crossfade moves toward the original recording. */
export function noteColorAlpha(hand: Hand, midi: number, alpha: number): string {
  return noteColor(hand, midi).replace("rgb(", "rgba(").replace(")", `,${alpha.toFixed(3)})`);
}

/* ── odds and ends ───────────────────────────────────────────────────────── */

/** Hz of a MIDI note, equal temperament, A4 = 440. */
export const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
export const noteName = (midi: number) =>
  NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

/** `m:ss`, clamped at zero so a playhead that drifts a frame negative doesn't
 *  render as `-1:59`. */
export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
