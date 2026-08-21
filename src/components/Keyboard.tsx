import { KEYS, KEY_MAP, isBlack, noteName } from "../roll";

/**
 * The keyboard the roll falls onto.
 *
 * All 88 keys, and none of them are React state. Lighting a key is a style
 * write from the animation loop through `register`, because keys change dozens
 * of times a second and re-rendering 88 elements to colour four of them would
 * be the most expensive thing on the page.
 */
export function Keyboard({
  register,
  onStrike,
}: {
  /** Called with each key's element as it mounts, and with null as it goes. */
  register: (midi: number, el: HTMLDivElement | null) => void;
  onStrike: (midi: number) => void;
}) {
  return (
    <div className="keys">
      {KEYS.map((midi) => {
        const geo = KEY_MAP[midi];
        return (
          <div
            key={midi}
            ref={(el) => register(midi, el)}
            className={`key ${isBlack(midi) ? "black" : "white"}`}
            style={{ left: `${geo.left}%`, width: `${geo.width}%` }}
            title={noteName(midi)}
            onMouseDown={() => onStrike(midi)}
          />
        );
      })}
    </div>
  );
}
