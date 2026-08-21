import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard } from "./components/Keyboard";
import { Roll } from "./components/Roll";
import { Sheet } from "./components/Sheet";
import { TopBar } from "./components/TopBar";
import { Transport } from "./components/Transport";
import { UploadModal } from "./components/UploadModal";
import { Working } from "./components/Working";
import { PIXELS_PER_SECOND, chordServiceEnabled } from "./config";
import { cropBuffer, cropSeconds, cropToWav, type Crop, type Source } from "./audio";
import { analyzeChords, chordAt, warmChordService } from "./chords";
import { Engine } from "./engine";
import { assignFingers, assignHands } from "./hands";
import { transcribe as transcribeWithMirelo } from "./mirelo";
import {
  DEFAULT_MODEL,
  TranscribeError,
  modelById,
  type ModelId,
  type Stage,
} from "./models";
import { transcribe as transcribeOnGpu } from "./muscriptor";
import { clock, isBlack, noteColor } from "./roll";
import type { BeatGrid, Chord, Note, Timing } from "./types";

type Phase = "idle" | "working" | "ready" | "error";

export default function App() {
  const engine = useEngine();

  const [notes, setNotes] = useState<Note[]>(residentArrangement);
  const [chords, setChords] = useState<Chord[]>([]);
  const [grid, setGrid] = useState<BeatGrid | null>(null);
  const [duration, setDuration] = useState(RESIDENT_DURATION);
  const [timing, setTiming] = useState<Timing | null>(null);
  const [midiUrl, setMidiUrl] = useState<string | null>(null);
  const [musicxmlUrl, setMusicxmlUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>("bach · prelude in c");

  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [view, setView] = useState<"roll" | "sheet">("roll");
  const [modalOpen, setModalOpen] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  const [blend, setBlend] = useState(0);
  const [speed, setSpeed] = useState(1);

  const rollRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const chordRef = useRef<HTMLSpanElement>(null);
  const keyEls = useRef(new Map<number, HTMLDivElement>());
  const rollHeight = useRef(0);
  /** The run that owns the UI. A second transcription supersedes the first, and
   *  every await in the older run checks this before writing anything back. */
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const busy = phase === "working";

  /* ── keep the engine in step with the state above ─────────────────────── */

  useEffect(() => engine.setNotes(notes, duration), [engine, notes, duration]);
  // The slider runs transcribed → original; the engine's mix runs the other
  // way, because it is a gain on the piano.
  useEffect(() => engine.setMix(1 - blend), [engine, blend]);
  useEffect(() => engine.setSpeed(speed), [engine, speed]);

  // The box hands back its MIDI in the stream rather than behind a link, so
  // that export is an object URL made here. It is revoked when the next
  // transcription replaces it, which Mirelo's presigned links do not need.
  useEffect(() => {
    if (!midiUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(midiUrl);
  }, [midiUrl]);

  // The roll fades out as the crossfade moves toward the recording, so what you
  // are hearing and what you are looking at agree. One write on the layer
  // rather than one per note.
  useEffect(() => {
    if (layerRef.current) layerRef.current.style.opacity = `${1 - 0.55 * blend}`;
  }, [blend]);

  /* ── the animation loop ───────────────────────────────────────────────── */

  // Everything in here is written straight to the DOM. React re-renders on
  // state changes only; the roll, the clock and the lit keys move 60 times a
  // second and would otherwise rebuild several hundred elements a frame.
  useEffect(() => {
    const measure = () => {
      rollHeight.current = rollRef.current?.clientHeight ?? 0;
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (rollRef.current) observer.observe(rollRef.current);

    let raf = 0;
    const lit = new Set<number>();

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const at = engine.position;

      if (layerRef.current) {
        const y = rollHeight.current + at * PIXELS_PER_SECOND;
        layerRef.current.style.transform = `translate3d(0,${y.toFixed(2)}px,0)`;
      }
      if (clockRef.current) {
        clockRef.current.textContent = `${clock(at)} / ${clock(engine.duration)}`;
      }
      if (scrubRef.current) {
        const done = engine.duration > 0 ? Math.min(1, at / engine.duration) : 0;
        scrubRef.current.style.width = `${(done * 100).toFixed(2)}%`;
      }
      if (chordRef.current) {
        const chord = chordAt(chords, at);
        const label = chord?.label ?? "";
        if (chordRef.current.textContent !== label) chordRef.current.textContent = label;
      }

      // Which keys are down. Only the ones that changed are touched, so a
      // steady chord costs nothing after the frame it lands on.
      const now = new Map<number, string>();
      for (const n of notes) {
        if (n.time <= at && at < n.time + n.dur) now.set(n.midi, noteColor(n.hand, n.midi));
      }
      for (const midi of lit) {
        if (!now.has(midi)) paintKey(keyEls.current.get(midi), midi, null);
      }
      for (const [midi, color] of now) {
        if (!lit.has(midi)) paintKey(keyEls.current.get(midi), midi, color);
      }
      lit.clear();
      for (const midi of now.keys()) lit.add(midi);

      // The transport can stop on its own when the clip runs out.
      if (engine.playing !== playing) setPlaying(engine.playing);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      for (const midi of lit) paintKey(keyEls.current.get(midi), midi, null);
    };
  }, [engine, notes, chords, playing]);

  /* ── transport ────────────────────────────────────────────────────────── */

  const toggle = useCallback(() => {
    if (engine.playing) {
      engine.pause();
      setPlaying(false);
    } else {
      void engine.play().then(() => setPlaying(engine.playing));
    }
  }, [engine]);

  const seek = useCallback((seconds: number) => engine.seek(seconds), [engine]);
  const seekFraction = useCallback(
    (fraction: number) => engine.seek(Math.max(0, Math.min(1, fraction)) * engine.duration),
    [engine],
  );

  // Space plays, and does not also scroll the page or re-trigger whichever
  // button happens to have focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (modalOpen) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "Home" || e.key === "0") {
        engine.seek(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, engine, modalOpen]);

  /* ── transcription ────────────────────────────────────────────────────── */

  const start = useCallback(
    async (source: Source, crop: Crop) => {
      const run = ++runRef.current;
      const stale = () => runRef.current !== run;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      engine.pause();
      // The click that started this is still the live gesture, so it is the
      // moment the AudioContext can be resumed — waiting for the play button
      // would work too, but this way the first note is never late.
      void engine.unlock();

      const span = cropSeconds(source, crop);
      const file = cropToWav(source, crop);
      const buffer = cropBuffer(source, crop);

      setModalOpen(false);
      setView("roll");
      setPhase("working");
      setStage("cutting the clip");
      setError(null);
      setNotes([]);
      setChords([]);
      setGrid(null);
      setTiming(null);
      setMidiUrl(null);
      setMusicxmlUrl(null);
      setFileName(`${source.name} · ${clock(span.start)}–${clock(span.end)}`);
      setSpeed(1);
      engine.setOriginal(buffer);
      setDuration(buffer.duration);

      // Chords, in parallel with the notes and from a different machine. They
      // are never worth failing a transcription over, so every error here
      // resolves to null and the roll simply has no bands on it.
      const chordRun = chordServiceEnabled
        ? warmChordService(controller.signal)
            .then((awake) => (awake ? analyzeChords(file, controller.signal) : null))
            .catch(() => null)
        : Promise.resolve(null);

      const picked = modelById(model);
      try {
        const handlers = {
          onStage: (s: Stage, detail?: string) =>
            !stale() && setStage(stageText(s, picked.service, detail)),
          onProgress: (fraction: number | null) => {
            if (stale() || fraction === null) return;
            setStage((current) => `${current.split(" · ")[0]} · ${Math.round(fraction * 100)}%`);
          },
          // Notes decoded so far, drawn while the model is still working.
          onNotes: (partial: Note[]) => !stale() && setNotes(partial),
        };
        const result =
          picked.backend === "muscriptor"
            ? await transcribeOnGpu(file, handlers, controller.signal)
            : await transcribeWithMirelo(
                file,
                picked.timing ?? "performance",
                handlers,
                controller.signal,
              );
        if (stale()) return;

        setNotes(result.notes);
        setGrid(result.grid);
        setTiming(result.timing);
        setMidiUrl(result.midiUrl);
        setMusicxmlUrl(result.musicxmlUrl);
        setDuration(Math.max(result.duration, buffer.duration));

        if (!result.notes.length) {
          setPhase("error");
          setError("nothing pitched came back from that clip — try a different one");
          return;
        }

        setPhase("ready");
        // Start it — unless the roll was already playing, which it can be:
        // the notes stream in and nothing stopped anyone pressing play at 40%.
        // Seeking back to the start there would yank the piece out from under
        // whoever is listening to it.
        if (!engine.playing) {
          engine.seek(0);
          void engine.play().then(() => setPlaying(engine.playing));
        }

        // The chords land whenever they land: the transcription is already
        // playing, and the bands appear under it.
        const recognized = await chordRun;
        if (!stale() && recognized?.length) setChords(recognized);
      } catch (e) {
        if (stale()) return;
        if (e instanceof DOMException && e.name === "AbortError") {
          setPhase("idle");
          setModalOpen(true);
          return;
        }
        setPhase("error");
        setError(
          e instanceof TranscribeError
            ? e.message
            : `could not reach the transcriber — ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    },
    [engine, model],
  );

  const cancel = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    setPhase("idle");
    setModalOpen(true);
  }, []);

  /* ── render ───────────────────────────────────────────────────────────── */

  const registerKey = useCallback((midi: number, el: HTMLDivElement | null) => {
    if (el) keyEls.current.set(midi, el);
    else keyEls.current.delete(midi);
  }, []);

  const sheetCaption = useMemo(() => {
    const bits = [`MusicXML · ${notes.length} notes`];
    if (grid?.detected) bits.push(`${Math.round(grid.bpm)} bpm · ${grid.beatsPerBar}/4`);
    if (timing) {
      bits.push(
        timing.applied === timing.requested
          ? timing.applied
          : `${timing.requested} → ${timing.applied}${timing.fallbackReason ? ` (${timing.fallbackReason})` : ""}`,
      );
    }
    return bits.join(" · ");
  }, [notes.length, grid, timing]);

  return (
    <div className="app">
      <TopBar
        model={model}
        onModel={setModel}
        view={view}
        onView={setView}
        fileName={fileName}
        onReplace={() => setModalOpen(true)}
        midiUrl={midiUrl}
        musicxmlUrl={musicxmlUrl}
      />

      <Roll
        notes={notes}
        chords={chords}
        pps={PIXELS_PER_SECOND}
        containerRef={rollRef}
        layerRef={layerRef}
        onSeekChord={seek}
        empty={
          <div className="roll-empty">
            <span className={`headline${phase === "error" ? " roll-error" : ""}`}>
              {error ?? "Nothing transcribed yet"}
            </span>
            <span className="sub">
              {phase === "error" ? "TRY ANOTHER FILE" : "DROP A RECORDING TO START"}
            </span>
          </div>
        }
      >
        {view === "sheet" && musicxmlUrl && (
          <Sheet musicxmlUrl={musicxmlUrl} caption={sheetCaption} />
        )}
        {busy && <Working stage={stage} onCancel={cancel} />}
      </Roll>

      <Keyboard register={registerKey} onStrike={(midi) => void engine.strike(midi)} />

      <Transport
        playing={playing}
        onToggle={toggle}
        onRestart={() => seek(0)}
        onSeekFraction={seekFraction}
        blend={blend}
        onBlend={setBlend}
        speed={speed}
        onSpeed={setSpeed}
        scrubRef={scrubRef}
        clockRef={clockRef}
        chordRef={chordRef}
        enabled={notes.length > 0}
      />

      {modalOpen && (
        <UploadModal
          onClose={() => setModalOpen(false)}
          onStart={(source, crop) => void start(source, crop)}
          canClose={notes.length > 0}
          model={modelById(model)}
        />
      )}

    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** One Engine for the life of the page, torn down on unmount. */
function useEngine(): Engine {
  const ref = useRef<Engine | null>(null);
  if (!ref.current) ref.current = new Engine();
  const engine = ref.current;
  useEffect(() => {
    engine.prepare();
    return () => engine.dispose();
  }, [engine]);
  return engine;
}

/** What the overlay says, named for whichever backend is working. `detail` is
 *  the queue position when there is one, which only the box reports. */
function stageText(stage: Stage, service: string, detail?: string): string {
  const head = (() => {
    switch (stage) {
      case "uploading":
        return "uploading the clip";
      case "queued":
        return `queued at ${service}`;
      case "transcribing":
        return "transcribing";
      case "engraving":
        return "engraving";
    }
  })();
  return detail ? `${head} · ${detail}` : head;
}

/** Light or clear one key. The unlit colour is the key's own, which is the
 *  only reason this does not need to know anything else about the keyboard. */
function paintKey(el: HTMLDivElement | undefined, midi: number, color: string | null) {
  if (!el) return;
  el.style.background = color ?? (isBlack(midi) ? "#0a0a0a" : "#ffffff");
  el.style.boxShadow = color ? `0 0 14px ${color}` : "none";
}

/* ── the resident arrangement ────────────────────────────────────────────── */

const RESIDENT_BEAT = 60 / 72;
const RESIDENT_DURATION = 8 * 4 * RESIDENT_BEAT;

/**
 * Bach's C major prelude, so the page has something to play before it has
 * anything to transcribe. Eight bars of the broken-chord figure, each bar
 * played twice, which is exactly how the piece is written — and it goes
 * through the same hand and fingering pass a real transcription does, so what
 * is behind the upload panel on load is the app working, not a mockup of it.
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
      out.push({ midi: bar[0], time: s, dur: beat * 0.92, vel: 0.9, hand: "L", finger: 5 });
      out.push({ midi: bar[1], time: s + six, dur: beat * 0.92, vel: 0.85, hand: "L", finger: 2 });
      [2, 3, 4, 2, 3, 4].forEach((idx, k) => {
        out.push({
          midi: bar[idx],
          time: s + (k + 2) * six,
          dur: six * 0.95,
          vel: 0.72,
          hand: "R",
          finger: 1,
        });
      });
    }
  });
  out.sort((a, b) => a.time - b.time);
  assignHands(out);
  assignFingers(out);
  return out;
}
