import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard } from "./components/Keyboard";
import { Roll } from "./components/Roll";
import { CLIP_SECONDS, chordServiceEnabled } from "./config";
import { Engine, type Pedal } from "./engine";
import { SilentAudioError, makeClip } from "./clip";
import { TranscribeError, analyzeChords, transcribe, warmChordService } from "./api";
import { clock } from "./roll";
import type { BeatGrid, Chord, Note } from "./types";

/** Pixels per second of music. Fixed: at 110 a bar of anything moderate is
 *  about a thumb's width, which is the zoom the roll was designed at. */
const PPS = 110;

type Phase = "idle" | "reading" | "queued" | "working" | "ready" | "error";

interface Loaded {
  title: string;
  /** Where in the original file the transcribed clip starts. */
  offset: number;
  source: string;
}

export default function App() {
  const engine = useEngine();

  const [notes, setNotes] = useState<Note[]>(() => residentArrangement());
  const [chords, setChords] = useState<Chord[]>([]);
  const [grid, setGrid] = useState<BeatGrid | null>(null);
  const [duration, setDuration] = useState(RESIDENT_DURATION);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pedal, setPedal] = useState<Pedal>("on");
  const [mix, setMix] = useState(0.72);
  const [chordsOn, setChordsOn] = useState(false);
  const [dragging, setDragging] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const railRef = useRef<HTMLSpanElement>(null);
  const chordRef = useRef<HTMLSpanElement>(null);
  /** The run that owns the UI. A second upload supersedes the first, and every
   *  await in the older run checks this before writing anything back. */
  const runRef = useRef(0);

  const busy = phase === "reading" || phase === "queued" || phase === "working";

  /* ── keep the engine in step with the state above ─────────────────────── */

  useEffect(() => engine.setNotes(notes, duration), [engine, notes, duration]);
  useEffect(() => engine.setGrid(grid), [engine, grid]);
  useEffect(() => engine.setChords(chords), [engine, chords, duration]);
  useEffect(() => engine.setPedal(pedal), [engine, pedal]);
  useEffect(() => engine.setMix(mix), [engine, mix]);
  useEffect(() => engine.setChordsEnabled(chordsOn), [engine, chordsOn]);

  /* ── the animation loop ───────────────────────────────────────────────── */

  // Everything in here is written straight to the DOM. React re-renders on
  // state changes only; the playhead, the clock and the lit keys move 60 times
  // a second and would otherwise re-render several hundred note elements each
  // time just to shift a transform.
  useEffect(() => {
    let raf = 0;
    const lit = new Map<number, string>();

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const at = engine.position;

      if (scrollRef.current) {
        scrollRef.current.style.transform = `translateY(${(at * PPS).toFixed(2)}px)`;
      }
      if (timeRef.current) {
        timeRef.current.textContent = `${clock(at)} / ${clock(engine.duration)}`;
      }

      // Which keys are down, and why. `n` is a transcribed note sounding, `c` a
      // key the chord pad is holding; a key doing both carries both, and the
      // keyboard shows the two differently — one fills, the other marks the
      // front edge.
      const now = new Map<number, string>();
      if (chordsOn) {
        const chord = chordAt(chords, at);
        if (chord && chord.root !== null) {
          for (const semis of chord.intervals) now.set(48 + chord.root + semis, "c");
        }
      }
      for (const n of notes) {
        if (n.time <= at && at < n.time + n.dur) {
          now.set(n.midi, now.has(n.midi) ? "nc" : "n");
        }
      }
      applyLit(lit, now);

      if (railRef.current) {
        railRef.current.textContent = `${engine.playing ? "▶" : "░"} ${at.toFixed(2)}s · ${now.size} voices`;
      }
      if (chordRef.current) {
        const chord = chordAt(chords, at);
        chordRef.current.textContent = chord ? `▸ ${chord.label}` : "";
      }
      // The transport can stop on its own when the clip runs out.
      if (engine.playing !== playing) setPlaying(engine.playing);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      applyLit(lit, new Map());
    };
  }, [engine, notes, chords, chordsOn, playing]);

  /* ── transport ────────────────────────────────────────────────────────── */

  const toggle = useCallback(() => {
    if (engine.playing) engine.pause();
    else engine.play();
    setPlaying(engine.playing);
  }, [engine]);

  const rewind = useCallback(() => {
    engine.seek(0);
  }, [engine]);

  const seek = useCallback(
    (seconds: number) => {
      engine.seek(seconds);
    },
    [engine],
  );

  // Space plays, and does not also scroll the page or re-trigger whichever
  // button happens to have focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "Home" || e.key === "0") {
        rewind();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, rewind]);

  /* ── transcription ────────────────────────────────────────────────────── */

  const start = useCallback(
    async (file: File) => {
      const run = ++runRef.current;
      const stale = () => runRef.current !== run;

      engine.pause();
      // The click that picked the file is still the live gesture, so this is
      // the moment the AudioContext can be resumed — waiting until the play
      // button would work too, but this way the first note is never late.
      void engine.unlock();

      setPhase("reading");
      setProgress(0);
      setStatus(`░ reading ${file.name.toLowerCase()}…`);
      setChords([]);
      setGrid(null);

      // Wake the chord Space now: it is a free CPU Space that sleeps when idle
      // and takes tens of seconds to come back, and the transcription is about
      // to spend at least that long on the GPU anyway.
      const warming = chordServiceEnabled
        ? warmChordService().catch(() => false)
        : Promise.resolve(false);

      let clip;
      try {
        clip = await makeClip(file);
      } catch (e) {
        if (stale()) return;
        setPhase("error");
        setStatus(
          e instanceof SilentAudioError
            ? `░ ${e.message} — try another one`
            : `░ could not decode that file — ${message(e)}`,
        );
        return;
      }
      if (stale()) return;

      const title = file.name.replace(/\.[^.]+$/, "").toLowerCase();
      setLoaded({ title, offset: clip.offset, source: "muscriptor" });
      // Swap in the recording and clear the resident arrangement, so the roll
      // is visibly waiting for this file rather than still showing the Bach.
      engine.setOriginal(clip.buffer);
      setNotes([]);
      setDuration(clip.duration);
      setPhase("queued");
      setStatus("░ waiting for the gpu…");

      // Chords, in parallel with the notes. They come back from a different
      // machine and are never worth failing the transcription over, so this
      // branch resolves to `null` on every error and the `/transcribe` chords
      // are used instead.
      const chordRun = warming
        .then((awake) => (awake ? analyzeChords(clip.file) : null))
        .catch(() => null);

      let pending: Note[] | null = null;
      const flush = window.setInterval(() => {
        if (!pending || stale()) return;
        setNotes(pending);
        pending = null;
      }, 140);

      try {
        const result = await transcribe(clip.file, {
          onQueued: (position) => {
            if (stale()) return;
            setPhase("queued");
            setStatus(
              position > 0
                ? `░ queued · ${position} ahead of you`
                : "░ queued · next up",
            );
          },
          onStarted: () => {
            if (stale()) return;
            setPhase("working");
            setStatus(`░ transcribing ${clock(clip.offset)}–${clock(clip.offset + clip.duration)}…`);
          },
          onProgress: (completed, total) => {
            if (!stale() && total > 0) setProgress(completed / total);
          },
          // Notes are drawn as they stream, but batched: an `end` event lands
          // every few milliseconds and each one would otherwise rebuild every
          // note element in the roll.
          onNotes: (streamed) => {
            pending = streamed;
          },
        });
        if (stale()) return;

        setNotes(result.notes);
        setGrid(result.grid);
        setDuration(Math.max(result.duration, clip.duration));

        const fromService = await chordRun;
        if (stale()) return;
        // Prefer the standalone service when it answered: it is the same model
        // the GPU box runs, but it also ran beat tracking of its own, so its
        // boundaries are the ones snapped to a grid it actually measured.
        const finalChords = fromService?.length ? fromService : result.chords;
        setChords(finalChords);
        setLoaded({
          title,
          offset: clip.offset,
          source: fromService?.length ? "muscriptor + btc" : "muscriptor",
        });

        if (!result.notes.length) {
          setPhase("error");
          setStatus("░ nothing pitched in that clip — try a different file");
          return;
        }
        setPhase("ready");
        setStatus(null);
        engine.seek(0);
      } catch (e) {
        if (stale()) return;
        setPhase("error");
        setStatus(`░ ${transcribeMessage(e)}`);
      } finally {
        clearInterval(flush);
      }
    },
    [engine],
  );

  const onFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input so picking the same file twice fires again.
      e.target.value = "";
      if (file) void start(file);
    },
    [start],
  );

  // Drag and drop, on the whole window — the file input is a small target and
  // dropping onto the roll is the obvious gesture.
  useEffect(() => {
    let depth = 0;
    const hasFile = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFile(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = () => {
      // dragleave fires when crossing into a child, so count rather than clear.
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFile(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      void start(file);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [start]);

  /* ── readouts ─────────────────────────────────────────────────────────── */

  const title = loaded?.title ?? "prelude in c · bwv 846";
  const meta = loaded
    ? `— ${loaded.source} · ${notes.length} notes · ${chords.length} chords · ${clock(loaded.offset)}–${clock(loaded.offset + duration)}`
    : "j. s. bach — resident arrangement";

  const bpm = grid?.bpm;
  const stats = `notes ${notes.length} │ ${bpm ? `${Math.round(bpm)}bpm` : "no tempo"} │ ${PPS}px/s`;
  const overlay = busy || phase === "error" ? status : null;

  return (
    <div className="app">
      <div className="strip">
        <span className="strip-kicker">new</span>
        <span>
          the {CLIP_SECONDS} most musical seconds go to a gpu — notes and chords come back
        </span>
        <span className="strip-spacer" />
        <span>muscriptor medium · btc-large-voca</span>
      </div>

      <header className="head">
        <h1>pianoify</h1>
        <select
          className="picker"
          value={pedal}
          onChange={(e) => setPedal(e.target.value as Pedal)}
          title="Damper pedal. Down, notes ring past their release until the harmony changes; up, they stop when the key does."
        >
          <option value="on">pedal · down</option>
          <option value="off">pedal · up</option>
        </select>
        <div className="head-title">
          <span className="name">{title}</span>
          <span className="meta">{meta}</span>
        </div>
        <label className={`btn btn-primary file-btn${busy ? " disabled" : ""}`}>
          {busy ? "working…" : "open audio"}
          <input type="file" accept="audio/*" onChange={onFile} disabled={busy} />
        </label>
      </header>

      <div className="stage">
        <div className="stage-dither" />
        <div className="frame">
          <div className="rail">
            <span>═ roll</span>
            <span>
              · c2–c7 · 61 keys · {notes.length} notes
              {chords.length ? ` · ${chords.length} chords` : ""}
            </span>
            <span className="rail-chord" ref={chordRef} />
            <span className="rail-spacer" />
            <span ref={railRef}>idle</span>
          </div>

          <Roll
            notes={notes}
            chords={chords}
            grid={grid}
            duration={duration}
            pps={PPS}
            showGrid
            chordsOn={chordsOn}
            scrollRef={scrollRef}
            onSeek={seek}
          />

          {overlay !== null && (
            <div className="overlay">
              <div className="overlay-card">
                {overlay}
                {phase === "working" && (
                  <div className="overlay-bar">
                    <span style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                )}
              </div>
            </div>
          )}

          <Keyboard onPress={(midi) => engine.strike(midi)} />
        </div>
      </div>

      <footer className="foot">
        <button className="btn btn-primary transport" onClick={toggle}>
          {playing ? "pause" : "play"}
        </button>
        <button className="btn btn-ghost link-btn" onClick={rewind}>
          rewind
        </button>
        <button
          className={`btn btn-secondary link-btn${chordsOn ? " chip-on" : ""}`}
          onClick={() => setChordsOn((on) => !on)}
          disabled={!chords.length}
          title={
            chords.length
              ? "Sound the recognized harmony under the transcription"
              : "No chord track yet — transcribe something first"
          }
        >
          {chords.length ? `chords · ${chordsOn ? "on" : "off"}` : "chords · —"}
        </button>
        <span className="mono" ref={timeRef}>
          0:00
        </span>
        <span className="foot-spacer" />
        <div className="mix">
          <span>original</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(mix * 100)}
            onChange={(e) => setMix(Number(e.target.value) / 100)}
            disabled={!loaded}
          />
          <span>piano</span>
          <span className="mix-value">
            {loaded
              ? `${Math.round((1 - mix) * 100)}/${Math.round(mix * 100)}`
              : "piano only"}
          </span>
        </div>
        <span className="foot-divider" />
        <span className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>
          {stats}
        </span>
      </footer>

      {dragging && <div className="drop">drop an audio file anywhere</div>}
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** One Engine for the life of the page, torn down on unmount. */
function useEngine(): Engine {
  const ref = useRef<Engine | null>(null);
  if (!ref.current) ref.current = new Engine();
  const engine = ref.current;
  useEffect(() => () => engine.dispose(), [engine]);
  return engine;
}

/** The chord sounding at `at` — the last change at or before it. */
function chordAt(chords: Chord[], at: number): Chord | null {
  let found: Chord | null = null;
  for (const c of chords) {
    if (c.time > at) break;
    found = c;
  }
  return found;
}

/** Light the keys named in `next`, touching only the ones whose state actually
 *  changed since `previous` — which is then updated in place. Keeping the
 *  record means clearing the keyboard never has to walk all 61 keys. */
function applyLit(previous: Map<number, string>, next: Map<number, string>) {
  const write = (midi: number, code: string | undefined) => {
    const el = document.querySelector(`[data-midi="${midi}"]`);
    if (!el) return;
    if (!code) {
      el.removeAttribute("data-lit");
      el.removeAttribute("data-chord");
      return;
    }
    el.setAttribute("data-lit", code.includes("n") ? "1" : "2");
    if (code.includes("c")) el.setAttribute("data-chord", "1");
    else el.removeAttribute("data-chord");
  };
  for (const midi of previous.keys()) if (!next.has(midi)) write(midi, undefined);
  for (const [midi, code] of next) if (previous.get(midi) !== code) write(midi, code);
  previous.clear();
  for (const [midi, code] of next) previous.set(midi, code);
}

function message(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "unknown error";
}

/** The most useful thing we can say about a failed transcription. The server's
 *  own `detail` beats anything invented here; a CORS refusal or a dead tunnel
 *  arrives as an opaque `TypeError` from fetch and needs the explanation. */
function transcribeMessage(e: unknown): string {
  if (e instanceof TranscribeError) {
    return e.userMessage ?? `the transcriber refused that (http ${e.status ?? "?"})`;
  }
  if (e instanceof TypeError) {
    return "could not reach the transcriber — it may be asleep, or this origin is not in its cors allowlist";
  }
  return message(e);
}

/* ── the resident arrangement ────────────────────────────────────────────── */

const RESIDENT_BEAT = 60 / 72;
const RESIDENT_DURATION = 8 * 4 * RESIDENT_BEAT;

/**
 * Bach's C major prelude, so the page has something to play before it has
 * anything to transcribe. Eight bars of the broken-chord figure, each bar
 * played twice, which is exactly how the piece is written.
 */
function residentArrangement(): Note[] {
  const beat = RESIDENT_BEAT;
  const six = beat / 4;
  const bars = [
    [48, 52, 55, 60, 64],
    [48, 50, 57, 62, 65],
    [47, 50, 55, 62, 65],
    [48, 52, 55, 60, 64],
    [48, 52, 57, 64, 69],
    [48, 50, 54, 57, 62],
    [47, 50, 55, 62, 67],
    [47, 48, 52, 55, 60],
  ];
  const out: Note[] = [];
  bars.forEach((bar, i) => {
    for (let half = 0; half < 2; half++) {
      const s = i * 4 * beat + half * 2 * beat;
      // The two held notes underneath, then the six-note figure over them.
      out.push({ midi: bar[0], time: s, dur: beat * 0.92, vel: 0.9 });
      out.push({ midi: bar[1], time: s + six, dur: beat * 0.92, vel: 0.85 });
      [2, 3, 4, 2, 3, 4].forEach((idx, k) => {
        out.push({ midi: bar[idx], time: s + (k + 2) * six, dur: six * 0.95, vel: 0.72 });
      });
    }
  });
  out.sort((a, b) => a.time - b.time);
  return out;
}
