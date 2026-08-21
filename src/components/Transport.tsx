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
  const dragging = useRef(false);

  const setFromEvent = useCallback(
    (clientX: number) => {
      const rect = track.current?.getBoundingClientRect();
      if (!rect) return;
      onBlend(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
    },
    [onBlend],
  );

  // The drag continues outside the track — a slider you lose the moment the
  // pointer leaves its 20px is not a slider.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragging.current) setFromEvent(e.clientX);
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [setFromEvent]);

  return (
    <footer className="transport">
      <div
        className="scrub"
        onClick={(e) => {
          if (!enabled) return;
          const rect = e.currentTarget.getBoundingClientRect();
          onSeekFraction((e.clientX - rect.left) / rect.width);
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
          onMouseDown={(e) => {
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
