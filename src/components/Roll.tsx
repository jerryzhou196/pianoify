import { useMemo, type RefObject } from "react";
import { KEY_MAP, LOW, HIGH, keyFor, noteColor } from "../roll";
import type { Chord, Note } from "../types";

/**
 * The falling roll.
 *
 * Everything is laid out once, in music time, and then moved as a single
 * transform: each note sits at `-(time + dur) · pps` inside a layer the
 * animation loop translates down by `height + position · pps`. So a note's
 * bottom edge crosses the keyboard exactly when it sounds, and a frame costs
 * one transform rather than a re-layout of several hundred rectangles.
 *
 * Colour is the hand and the register — see `noteColor`. The fingering is only
 * drawn on notes tall enough to hold a circle, because a number on a sixteenth
 * at this zoom is a smudge.
 */
export function Roll({
  notes,
  chords,
  pps,
  containerRef,
  layerRef,
  onSeekChord,
  empty,
  children,
}: {
  notes: Note[];
  chords: Chord[];
  pps: number;
  containerRef: RefObject<HTMLDivElement | null>;
  layerRef: RefObject<HTMLDivElement | null>;
  onSeekChord: (time: number) => void;
  empty: React.ReactNode;
  /** Anything that covers the roll — the sheet-music panel. It belongs inside
   *  this element, not beside it: `.roll` is the only positioned ancestor in
   *  the column, so an `inset: 0` overlay mounted as a sibling lays itself out
   *  against the viewport and swallows the header, the keyboard and the
   *  transport along with the roll. */
  children?: React.ReactNode;
}) {
  // The octave rules, drawn behind everything. They are the only thing telling
  // you where on the keyboard you are looking while the roll is moving.
  const octaves = useMemo(() => {
    const out: number[] = [];
    for (let m = LOW; m <= HIGH; m++) if (m % 12 === 0) out.push(KEY_MAP[m].left);
    return out;
  }, []);

  const drawn = useMemo(
    () =>
      notes.map((n, i) => {
        const { geo } = keyFor(n.midi);
        const height = Math.max(2, n.dur * pps);
        const color = noteColor(n.hand, n.midi);
        return (
          <div
            key={i}
            className="roll-note"
            style={{
              left: `calc(${geo.left}% + 1px)`,
              width: `calc(${geo.width}% - 2px)`,
              top: `${-(n.time + n.dur) * pps}px`,
              height: `${height}px`,
              background: color,
              borderColor: color,
            }}
          >
            {height > 30 && <div className="roll-finger">{n.finger}</div>}
          </div>
        );
      }),
    [notes, pps],
  );

  const marks = useMemo(
    () =>
      chords.map((c, i) => (
        <div key={i} className="roll-chord" style={{ top: `${-c.time * pps}px` }}>
          <div className="rule" />
          <button
            className="label"
            onClick={() => onSeekChord(c.time)}
            title={`jump to ${c.label}`}
          >
            {c.label}
          </button>
        </div>
      )),
    [chords, pps, onSeekChord],
  );

  return (
    <div className="roll" ref={containerRef}>
      {octaves.map((left, i) => (
        <div key={i} className="roll-octave" style={{ left: `${left}%` }} />
      ))}
      <div className="roll-layer" ref={layerRef}>
        {marks}
        {drawn}
      </div>
      {!notes.length && empty}
      {children}
    </div>
  );
}
