import { useMemo } from "react";
import type { CSSProperties, RefObject } from "react";
import { HIGH, KEY_MAP, LOW, keyFor } from "../roll";
import type { BeatGrid, Chord, Note } from "../types";

interface RollProps {
  notes: Note[];
  chords: Chord[];
  grid: BeatGrid | null;
  duration: number;
  /** Pixels per second — how tall a second of music is. */
  pps: number;
  showGrid: boolean;
  chordsOn: boolean;
  /** The layer the playhead transform is written to, every frame, without
   *  React — re-rendering hundreds of note divs at 60fps is the one thing that
   *  would make this stutter. */
  scrollRef: RefObject<HTMLDivElement | null>;
  onSeek: (seconds: number) => void;
}

export function Roll({
  notes,
  chords,
  grid,
  duration,
  pps,
  showGrid,
  chordsOn,
  scrollRef,
  onSeek,
}: RollProps) {
  // Octave lanes never change; the rest is keyed on what it actually depends
  // on, so streaming in a note doesn't rebuild the grid.
  const lanes = useMemo(() => buildLanes(), []);
  const lines = useMemo(
    () => (showGrid ? buildGrid(grid, duration, pps) : []),
    [showGrid, grid, duration, pps],
  );
  const noteStyles = useMemo(() => buildNotes(notes, pps), [notes, pps]);
  const bands = useMemo(() => buildChords(chords, pps), [chords, pps]);

  return (
    <div className="roll">
      <div className="roll-scroll" ref={scrollRef}>
        {lanes.map((style, i) => (
          <div key={`lane-${i}`} style={style} />
        ))}
        {lines.map((style, i) => (
          <div key={`grid-${i}`} style={style} />
        ))}
        {bands.map((band) => (
          <div
            key={`chord-${band.key}`}
            className="chord-line"
            data-off={chordsOn ? "0" : "1"}
            style={{ bottom: band.bottom }}
            onClick={() => onSeek(band.time)}
            title={`${band.label} — jump to ${band.time.toFixed(2)}s`}
          >
            <span className="chord-label">{band.label}</span>
          </div>
        ))}
        {noteStyles.map((style, i) => (
          <div key={`note-${i}`} style={style} />
        ))}
      </div>
      <div className="roll-fade" />
      <div className="roll-playhead" />
    </div>
  );
}

/** A hairline up each C, so the eye can find an octave without counting keys. */
function buildLanes(): CSSProperties[] {
  const out: CSSProperties[] = [];
  for (let m = LOW; m <= HIGH; m++) {
    if (m % 12 !== 0) continue;
    out.push({
      position: "absolute",
      top: 0,
      bottom: 0,
      left: `${KEY_MAP[m].left}%`,
      width: "1px",
      background: "color-mix(in srgb, var(--color-text) 9%, transparent)",
    });
  }
  return out;
}

/**
 * Horizontal rules for the beat.
 *
 * With a detected grid these are real bar lines, phase-locked to the first
 * downbeat, and the heavier ones fall where the bar does — which is what makes
 * the chord changes visibly land *on* something. Without one there is no
 * musical unit to draw, so it degrades to plain seconds rather than inventing
 * a tempo.
 */
function buildGrid(grid: BeatGrid | null, duration: number, pps: number): CSSProperties[] {
  const span = duration + 2;
  const beat = grid && grid.bpm > 0 ? 60 / grid.bpm : 1;
  const perBar = grid?.beatsPerBar || 4;
  const phase = grid?.firstDownbeat ?? 0;
  const out: CSSProperties[] = [];
  // Start at the last beat at or before zero, so the phase is honoured even
  // when the first downbeat sits some way into the clip.
  let i = Math.floor(-phase / beat);
  for (; i * beat + phase < span; i++) {
    const t = i * beat + phase;
    if (t < 0) continue;
    // `i` counts from the downbeat, so the modulo is the position in the bar.
    const bar = ((i % perBar) + perBar) % perBar === 0;
    out.push({
      position: "absolute",
      left: 0,
      right: 0,
      bottom: `${(t * pps).toFixed(1)}px`,
      height: "1px",
      background: bar
        ? "var(--color-divider)"
        : "color-mix(in srgb, var(--color-text) 6%, transparent)",
    });
  }
  return out;
}

function buildNotes(notes: Note[], pps: number): CSSProperties[] {
  return notes.map((n) => {
    const { geo, midi } = keyFor(n.midi);
    // Below the octave under middle C reads as the left hand; give it the
    // neutral ink so the melody stays the thing in accent.
    const bass = midi < 52;
    return {
      position: "absolute",
      left: `calc(${geo.left}% + 1px)`,
      width: `calc(${geo.width}% - 2px)`,
      bottom: `${(n.time * pps).toFixed(1)}px`,
      // A grace note is still a note: never let one round away to nothing.
      height: `${Math.max(3, n.dur * pps).toFixed(1)}px`,
      background: bass
        ? "color-mix(in srgb, var(--color-text) 7%, transparent)"
        : "color-mix(in srgb, var(--color-accent) 20%, transparent)",
      border: `1px solid ${bass ? "var(--color-neutral-600)" : "var(--color-accent-600)"}`,
      borderRadius: "var(--radius-sm)",
      opacity: 0.55 + 0.45 * n.vel,
    };
  });
}

interface Band {
  key: string;
  label: string;
  time: number;
  bottom: string;
}

function buildChords(chords: Chord[], pps: number): Band[] {
  return chords
    .filter((c) => c.label)
    .map((c, i) => ({
      key: `${i}-${c.time}`,
      label: c.label,
      time: c.time,
      bottom: `${(c.time * pps).toFixed(1)}px`,
    }));
}
