import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Play, position, crossfade, speed.
 *
 * The clock, the progress bar and the chord readout are written by the
 * animation loop through the refs handed in, not by React — they change every
 * frame, and the rest of this bar changes about once a minute.
 */
export function Transport({
  playing,
  onToggle,
  onRestart,
  onSeekFraction,
  blend,
  onBlend,
  speed,
  onSpeed,
  scrubRef,
  clockRef,
  chordRef,
  enabled,
}: {
  playing: boolean;
  onToggle: () => void;
  onRestart: () => void;
  onSeekFraction: (fraction: number) => void;
  /** 0 = the transcription alone, 1 = the recording alone. */
  blend: number;
  onBlend: (blend: number) => void;
  speed: number;
  onSpeed: (speed: number) => void;
  scrubRef: RefObject<HTMLDivElement | null>;
  clockRef: RefObject<HTMLSpanElement | null>;
  chordRef: RefObject<HTMLSpanElement | null>;
  enabled: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const scrubbing = useRef(false);
  const lastSeek = useRef(0);
  const lastX = useRef(0);

  const setFromEvent = useCallback(
    (clientX: number) => {
      const rect = track.current?.getBoundingClientRect();
      if (!rect) return;
      onBlend(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
    },
    [onBlend],
  );

  /** Seeking is not free: the engine silences every sounding voice and starts
   *  the original recording again from the new offset. Sixty of those a second
   *  is a drag that sounds like tearing paper, so one lands every tenth of a
   *  second while the pointer moves and one lands on release, which reads as
   *  continuous and is not. */
  const seekFromEvent = useCallback(
    (clientX: number, settle: boolean) => {
      const rect = bar.current?.getBoundingClientRect();
      if (!rect) return;
      const now = performance.now();
      if (!settle && now - lastSeek.current < 100) return;
      lastSeek.current = now;
      onSeekFraction((clientX - rect.left) / rect.width);
    },
    [onSeekFraction],
  );

  // Both drags continue outside the strip they started on — a slider you lose
  // the moment the pointer leaves its 20px is not a slider. Pointer events
  // rather than mouse ones, so the same handler serves a finger: on a phone
  // these were the two controls with nothing listening at all.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      lastX.current = e.clientX;
      if (dragging.current) setFromEvent(e.clientX);
      if (scrubbing.current) seekFromEvent(e.clientX, false);
    };
    const up = () => {
      if (scrubbing.current) seekFromEvent(lastX.current, true);
      dragging.current = false;
      scrubbing.current = false;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [setFromEvent, seekFromEvent]);

  return (
    <footer className="transport">
      <div
        className="scrub"
        ref={bar}
        onPointerDown={(e) => {
          if (!enabled) return;
          scrubbing.current = true;
          lastX.current = e.clientX;
          seekFromEvent(e.clientX, true);
        }}
      >
        <div className="fill" ref={scrubRef} />
      </div>

      <div className="transport-left">
        <button className="icon-button" onClick={onRestart} disabled={!enabled} title="back to the start">
          |◀
        </button>
        <button
          className="play"
          onClick={onToggle}
          disabled={!enabled}
          title={playing ? "pause (space)" : "play (space)"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="clock" ref={clockRef}>
          0:00 / 0:00
        </span>
        <span className="chord-now" ref={chordRef} />
      </div>

      <div className="blend">
        <span className="blend-label" data-active={blend < 0.5 ? 1 : 0}>
          TRANSCRIBED
        </span>
        <div
          className="blend-track"
          ref={track}
          data-disabled={enabled ? 0 : 1}
          onPointerDown={(e) => {
            if (!enabled) return;
            dragging.current = true;
            setFromEvent(e.clientX);
          }}
        >
          <div className="rail" />
          <div className="knob" style={{ left: `${blend * 100}%` }} />
        </div>
        <span className="blend-label right" data-active={blend > 0.5 ? 1 : 0}>
          ORIGINAL
        </span>
      </div>

      <div className="speed">
        <button
          className="step"
          onClick={() => onSpeed(Math.max(0.25, +(speed - 0.25).toFixed(2)))}
          disabled={!enabled || speed <= 0.25}
          title="slower"
        >
          −
        </button>
        <span className="value">{speed}x</span>
        <button
          className="step"
          onClick={() => onSpeed(Math.min(2, +(speed + 0.25).toFixed(2)))}
          disabled={!enabled || speed >= 2}
          title="faster"
        >
          +
        </button>
      </div>
    </footer>
  );
}
