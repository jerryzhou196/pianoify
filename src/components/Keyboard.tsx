import { useMemo } from "react";
import { HIGH, KEY_MAP, LOW, isBlack } from "../roll";

interface KeyboardProps {
  /** Strike a note directly. The keyboard is playable whether or not anything
   *  has been transcribed — it is the fastest way to hear what the pedal
   *  setting actually does. */
  onPress: (midi: number) => void;
}

/**
 * C2–C7, drawn as two layers: whites laid edge to edge, blacks overhanging on
 * top. Keys carry `data-midi` and are lit by writing `data-lit` straight to the
 * DOM from the animation loop — the alternative is re-rendering 61 elements
 * every frame to change two of them.
 */
export function Keyboard({ onPress }: KeyboardProps) {
  const { whites, blacks, marks } = useMemo(build, []);
  return (
    <div className="keys">
      {whites.map((k) => (
        <div
          key={k.midi}
          className="key-white"
          data-midi={k.midi}
          style={{ left: `${k.left}%`, width: `${k.width}%` }}
          onMouseDown={() => onPress(k.midi)}
        />
      ))}
      {blacks.map((k) => (
        <div
          key={k.midi}
          className="key-black"
          data-midi={k.midi}
          style={{ left: `${k.left}%`, width: `${k.width}%` }}
          onMouseDown={() => onPress(k.midi)}
        />
      ))}
      {marks.map((m) => (
        <span
          key={m.midi}
          className="octave-mark"
          style={{ left: `calc(${m.left}% + 3px)` }}
        >
          {m.label}
        </span>
      ))}
    </div>
  );
}

interface Key {
  midi: number;
  left: number;
  width: number;
}

function build() {
  const whites: Key[] = [];
  const blacks: Key[] = [];
  const marks: { midi: number; left: number; label: string }[] = [];
  for (let m = LOW; m <= HIGH; m++) {
    const geo = KEY_MAP[m];
    const key = { midi: m, left: geo.left, width: geo.width };
    if (isBlack(m)) blacks.push(key);
    else whites.push(key);
    if (m % 12 === 0) {
      marks.push({ midi: m, left: geo.left, label: `c${m / 12 - 1}` });
    }
  }
  return { whites, blacks, marks };
}
