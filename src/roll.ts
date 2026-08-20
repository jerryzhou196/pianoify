/** Lowest and highest key drawn. C2–C7 is 61 keys: wide enough for everything
 *  a transcription of a song actually puts down, narrow enough that a key is
 *  still a clickable target at 1280px. */
export const LOW = 36;
export const HIGH = 96;

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
      map[m] = { left: wi * w - w * 0.3, width: w * 0.6, black: true };
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

/** Geometry for a note that may be off the drawn range: fold it into the
 *  nearest octave inside C2–C7 rather than dropping it, so a stray bass note
 *  still shows up somewhere musically sensible. */
export function keyFor(midi: number): { geo: KeyGeometry; midi: number } {
  let m = midi;
  while (m < LOW) m += 12;
  while (m > HIGH) m -= 12;
  return { geo: KEY_MAP[m], midi: m };
}

/** Hz of a MIDI note, equal temperament, A4 = 440. */
export const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

const NAMES = ["c", "c♯", "d", "e♭", "e", "f", "f♯", "g", "a♭", "a", "b♭", "b"];
export const noteName = (midi: number) =>
  NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

/** `m:ss`, clamped at zero so a playhead that drifts a frame negative doesn't
 *  render as `-1:59`. */
export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
