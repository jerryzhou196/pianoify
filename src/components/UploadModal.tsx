import { useCallback, useEffect, useRef, useState } from "react";
import {
  SilentAudioError,
  cropSeconds,
  decodeSource,
  suggestCrop,
  type Crop,
  type Source,
} from "../audio";
import { LinkError, fetchLink, isYouTube } from "../links";
import { quote } from "../mirelo";
import { ModelPicker } from "./ModelPicker";
import { modelById, type ModelId } from "../models";
import { clock } from "../roll";

/** How close to an edge counts as grabbing it, in pixels. Wide enough for a
 *  finger, narrow enough that the middle of a ten-second window on a phone is
 *  still the middle. */
const GRIP_PX = 16;

/** The shortest window the handles will make, in seconds — and the shortest
 *  clip the Transcribe button will send. Under a second there is nothing for
 *  either model to find, and a window pinched to zero cannot be grabbed open
 *  again. */
const MIN_CLIP_SECONDS = 1;

/**
 * Choosing what to transcribe.
 *
 * The file is decoded here, in the browser, before anything is sent — which is
 * what makes the rest of this panel possible. The waveform is that decode; the
 * window slides over it; the play button previews exactly what will be sent;
 * and the credits under the button are quoted for that window.
 *
 * The window has two handles and a middle: drag an edge to change how long the
 * clip is, drag the body to change where it starts. It opens on ten seconds
 * either way, which is the length worth being wrong about — a file dropped and
 * transcribed without touching the waveform costs 25 credits, and the minutes
 * are there for whoever goes looking for them.
 *
 * How far the edges pull apart is the model's business, not this panel's:
 * Mirelo bills by the second and stops at ten minutes, the GPU box is rented
 * by the hour and stops nowhere. `maxSeconds` in `src/models.ts` is where that
 * is written down, and switching the picker to the stricter one pulls an
 * over-long window back to fit rather than waiting to be refused.
 */
export function UploadModal({
  onStart,
  model,
  onModel,
}: {
  onStart: (source: Source, crop: Crop) => void;
  model: ModelId;
  onModel: (model: ModelId) => void;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [crop, setCrop] = useState<Crop>({ a: 0, b: 1 });
  const [hot, setHot] = useState(false);
  const [url, setUrl] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  /** Which part of the window is under the pointer right now, so the grips can
   *  light up while one is being pulled. Only the cursor and a highlight ride
   *  on it — the crop itself lives in `cropRef`, which cannot wait for a
   *  render. */
  const [dragging, setDragging] = useState<"start" | "end" | "body" | null>(null);
  const [price, setPrice] = useState<{ credits: number | null; estimated_ms: number | null } | null>(
    null,
  );

  const wave = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  /** What the pointer took hold of, and — for the body of the window — where
   *  in it, as a fraction of the file. The offset is what makes a drag move
   *  the window *with* the pointer instead of jumping its start to wherever
   *  the pointer happens to be. */
  const grab = useRef<{ part: "start" | "end" | "body"; offset: number } | null>(null);
  /** The live crop, for the preview loop and the drag handler, neither of
   *  which can wait for a re-render to see the state they just set. */
  const cropRef = useRef(crop);
  cropRef.current = crop;

  /* ── loading ──────────────────────────────────────────────────────────────── */

  const load = useCallback(async (file: File) => {
    setError(null);
    setReading(`decoding ${file.name}…`);
    try {
      const decoded = await decodeSource(file);
      setSource(decoded);
      setCrop(suggestCrop(decoded));
      setPlaying(false);
      // The preview plays the original file rather than the decoded buffer:
      // an <audio> element already knows how to stream, seek and stop, and the
      // bytes are right here.
      audio.current?.pause();
      if (audio.current?.src) URL.revokeObjectURL(audio.current.src);
      const el = new Audio(URL.createObjectURL(file));
      el.preload = "metadata";
      el.onended = () => setPlaying(false);
      audio.current = el;
    } catch (e) {
      setSource(null);
      setError(
        e instanceof SilentAudioError
          ? `${e.message} — try another one`
          : `could not decode that file — ${e instanceof Error ? e.message : "unknown error"}`,
      );
    } finally {
      setReading(null);
    }
  }, []);

  const fromUrl = useCallback(async () => {
    const link = url.trim();
    if (!link) return;
    setError(null);
    // A YouTube download runs at roughly half the video's own length and gives
    // no progress until it is finished, so the seconds are counted out loud
    // rather than left to feel like a hang.
    const youtube = isYouTube(link);
    setWaited(0);
    setReading(youtube ? "asking youtube for the audio…" : "fetching…");
    const ticker = window.setInterval(() => setWaited((n) => n + 1), 1000);
    try {
      await load(await fetchLink(link));
    } catch (e) {
      setReading(null);
      setError(e instanceof LinkError ? e.message : "could not fetch that link");
    } finally {
      clearInterval(ticker);
    }
  }, [url, load]);

  useEffect(
    () => () => {
      audio.current?.pause();
      if (audio.current?.src) URL.revokeObjectURL(audio.current.src);
    },
    [],
  );

  /* ── moving and resizing the window ────────────────────────────────────── */

  const picked = modelById(model);

  /** The window's limits, as fractions of the file.
   *
   *  `max` is the model's cap where it has one and the whole file where it
   *  does not, so on the box the handles simply run to the ends. `min` keeps
   *  a drag from collapsing the window to a line nobody can grab again — and
   *  matches the length the Transcribe button already refuses to send. */
  const max = source
    ? picked.maxSeconds == null
      ? 1
      : Math.min(picked.maxSeconds / source.duration, 1)
    : 1;
  const min = source ? Math.min(MIN_CLIP_SECONDS / source.duration, max) : 1;
  const adjustable = max > min;

  /** Put the window at `start` keeping its length, without running off either
   *  end of the file. */
  const moveTo = useCallback((start: number, span: number) => {
    const a = Math.max(0, Math.min(start, 1 - span));
    setCrop({ a, b: a + span });
  }, []);

  useEffect(() => {
    const move = (x: number) => {
      const held = grab.current;
      const rect = wave.current?.getBoundingClientRect();
      if (!held || !rect) return;
      const at = (x - rect.left) / rect.width;
      const { a, b } = cropRef.current;
      if (held.part === "body") {
        moveTo(at - held.offset, b - a);
      } else if (held.part === "start") {
        // The far edge stays put, so the near one is fenced in by how short
        // and how long the window is allowed to be.
        setCrop({ a: clamp(at, Math.max(0, b - max), b - min), b });
      } else {
        setCrop({ a, b: clamp(at, a + min, Math.min(1, a + max)) });
      }
    };
    const onMouse = (e: MouseEvent) => move(e.clientX);
    // A finger on the waveform slides the window instead of scrolling the page
    // behind it. touch-action on the slidable wave claims the gesture up front,
    // and preventDefault here keeps a drag that wanders off the strip from
    // being handed back to the page as a scroll halfway through.
    const onTouch = (e: TouchEvent) => {
      if (grab.current === null) return;
      e.preventDefault();
      move(e.touches[0].clientX);
    };
    const up = () => {
      grab.current = null;
      setDragging(null);
    };
    window.addEventListener("mousemove", onMouse);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", onTouch, { passive: false });
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", up);
    return () => {
      window.removeEventListener("mousemove", onMouse);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [moveTo, min, max]);

  /**
   * Work out what was grabbed.
   *
   * Within a handle's width of either edge, it is that edge — measured in
   * pixels rather than in fractions of the file, because a handle has to stay
   * the same size to the finger whether the file is a minute or an hour.
   * Inside the window, it is the window. Outside it, the window comes to the
   * pointer first, so a press at the far end of a long file still gets you
   * there in one gesture rather than in several.
   */
  const startAt = (clientX: number) => {
    const rect = wave.current?.getBoundingClientRect();
    if (!rect) return;
    const at = (clientX - rect.left) / rect.width;
    const { a, b } = cropRef.current;
    const grip = GRIP_PX / rect.width;

    if (adjustable && Math.abs(at - a) <= grip) {
      grab.current = { part: "start", offset: 0 };
    } else if (adjustable && Math.abs(at - b) <= grip) {
      grab.current = { part: "end", offset: 0 };
    } else if (at >= a && at <= b) {
      grab.current = { part: "body", offset: at - a };
    } else {
      const span = b - a;
      grab.current = { part: "body", offset: span / 2 };
      moveTo(at - span / 2, span);
    }
    setDragging(grab.current.part);
  };

  const startDrag = (e: React.MouseEvent) => startAt(e.clientX);
  const startTouch = (e: React.TouchEvent) => startAt(e.touches[0].clientX);

  /** Pull the window back inside the model's cap when the picker changes.
   *
   *  Three minutes chosen on the box and then handed to Mirelo is fine; forty
   *  is a clip Mirelo would refuse, and finding that out at the Transcribe
   *  button — after a quote that could not be got either — is worse than
   *  watching the window shorten under the pointer. It keeps its start, since
   *  where the clip begins is the part that was chosen deliberately. */
  useEffect(() => {
    setCrop((current) =>
      current.b - current.a > max ? { a: current.a, b: current.a + max } : current,
    );
  }, [max]);

  /* ── the preview ────────────────────────────────────────────────────────── */

  // The playhead is written straight to the DOM, for the same reason the roll's
  // is: it moves every frame and nothing else in this panel does. The same loop
  // stops the preview at the end of the window, which is what makes the play
  // button mean "hear what will be sent" rather than "hear the file".
  useEffect(() => {
    if (!source) return;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const el = audio.current;
      if (!el) return;
      if (head.current) {
        head.current.style.left = `${Math.min(100, (el.currentTime / source.duration) * 100)}%`;
        head.current.style.opacity = el.paused ? "0" : "1";
      }
      if (!el.paused && el.currentTime >= cropRef.current.b * source.duration) {
        el.pause();
        setPlaying(false);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [source]);

  const togglePreview = () => {
    const el = audio.current;
    if (!el || !source) return;
    if (!el.paused) {
      el.pause();
      setPlaying(false);
      return;
    }
    // Always from the top of the window, never resuming where a pause left off.
    // The button means "hear the clip I am about to send", and that only holds
    // if every press plays the same thing: nudge the window a second later,
    // press again, and what you hear is the comparison you asked for rather
    // than whatever tail of the old position happened to be left over.
    el.currentTime = crop.a * source.duration;
    void el
      .play()
      .then(() => setPlaying(true))
      .catch(() => {
        // Autoplay policy, or a codec the element cannot stream even though
        // WebAudio decoded it. The waveform is still the important part.
      });
  };

  /* ── the quote ────────────────────────────────────────────────────────── */

  const window_ = source ? cropSeconds(source, crop) : null;
  const seconds = window_ ? window_.end - window_.start : 0;

  // Only Mirelo has a price to quote — the box is rented by the hour, so a clip
  // on it costs nothing extra and there is nothing to ask before sending it.
  //
  // Re-quoted as the window settles. Debounced, because a drag would otherwise
  // fire a request per frame, and abandoned on the way out so a stale answer
  // cannot land on a newer window.
  useEffect(() => {
    if (!modelById(model).billed || !source || seconds <= 0) {
      setPrice(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void quote(seconds, controller.signal).then(setPrice);
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [model, source, seconds]);

  /* ── render ──────────────────────────────────────────────────────────── */

  const left = crop.a * 100;
  const right = crop.b * 100;
  // What this clip will cost. Null while an answer is still on its way — the
  // line simply has one fewer thing in it until it lands.
  const cost = !picked.billed
    ? "no credits"
    : price?.credits != null
      ? `${price.credits} credits`
      : null;

  return (
    <div className="scrim">
      <div className="modal">
        <div className="modal-head">
          <span className="title">New transcription</span>
          {/* Which model, chosen before the file rather than after it: the
              header's copy of this picker is behind the scrim, and out of
              reach until something has already been transcribed. */}
          <ModelPicker model={model} onModel={onModel} />
        </div>

        <div className="url">
          <span className="tag">YT</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void fromUrl();
            }}
            placeholder="Paste a YouTube link, or a direct link to an audio file"
          />
          <button onClick={() => void fromUrl()} disabled={!url.trim() || reading !== null}>
            Fetch
          </button>
        </div>

        <div className="or">
          <div className="rule" />
          <span>OR</span>
          <div className="rule" />
        </div>

        <label
          className="drop"
          data-hot={hot ? 1 : 0}
          onDragOver={(e) => {
            e.preventDefault();
            setHot(true);
          }}
          onDragLeave={() => setHot(false)}
          onDrop={(e) => {
            e.preventDefault();
            setHot(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void load(file);
          }}
        >
          <span className="headline">
            {reading
              ? `${reading}${waited > 2 ? ` ${waited}s` : ""}`
              : "Drop an audio file, or click to browse"}
          </span>
          <span className="hint">MP3 · WAV · M4A · FLAC — up to 10 min</span>
          <input
            type="file"
            accept="audio/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void load(file);
            }}
          />
        </label>

        {error && <div className="modal-error">{error}</div>}

        {source && window_ && (
          <>
            <div className="trim">
              <div className="trim-head">
                <div className="trim-head-left">
                  <button
                    className="preview"
                    onClick={togglePreview}
                    title={playing ? "stop the preview" : "preview these seconds"}
                  >
                    <span className="glyph">{playing ? "❚❚" : "▶"}</span>
                    {playing ? "Stop" : "Play selection"}
                  </button>
                  <span className="caption">
                    {!adjustable
                      ? "WHOLE FILE"
                      : max < 1
                        ? `DRAG · EDGES RESIZE · MAX ${clock(picked.maxSeconds!)}`
                        : "DRAG · EDGES RESIZE"}
                  </span>
                </div>
                <span className="readout">
                  {clock(window_.start)} → {clock(window_.end)} ({length(seconds)})
                </span>
              </div>

              <div
                className="wave"
                ref={wave}
                data-slidable={adjustable ? 1 : 0}
                data-dragging={dragging ?? ""}
                onMouseDown={startDrag}
                onTouchStart={startTouch}
              >
                <div className="wave-bars">
                  {Array.from(source.peaks).map((amp, i) => {
                    const at = (i + 0.5) / source.peaks.length;
                    return (
                      <i
                        key={i}
                        data-in={at >= crop.a && at <= crop.b ? 1 : 0}
                        style={{ height: `${Math.max(6, amp * 100)}%` }}
                      />
                    );
                  })}
                </div>
                <div className="wave-mask left" style={{ width: `${left}%` }} />
                <div className="wave-mask right" style={{ width: `${100 - right}%` }} />
                {/* The edges, drawn as something to take hold of. They carry no
                    handlers of their own — the strip below them does the hit
                    testing in pixels, so a grip stays the same size to the
                    finger however long the file is. */}
                {adjustable && (
                  <>
                    <div
                      className="wave-grip"
                      data-lit={dragging === "start" ? 1 : 0}
                      style={{ left: `${left}%` }}
                    />
                    <div
                      className="wave-grip"
                      data-lit={dragging === "end" ? 1 : 0}
                      style={{ left: `${right}%` }}
                    />
                  </>
                )}
                <div className="wave-head" ref={head} />
              </div>
            </div>

            <div className="modal-foot">
              <span className="quote">
                {[
                  picked.name,
                  cost,
                  price?.estimated_ms != null
                    ? `about ${Math.max(1, Math.round(price.estimated_ms / 1000))}s`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <button
                className="go"
                disabled={seconds < MIN_CLIP_SECONDS}
                onClick={() => {
                  audio.current?.pause();
                  onStart(source, crop);
                }}
              >
                Transcribe
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/** How long the window is, in whichever unit reads. Under a minute the tenth
 *  of a second is the interesting digit, because it is the difference between
 *  catching an onset and clipping it; past that nobody is counting in tenths,
 *  and `2:14` is the number the transport will show anyway. */
function length(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(1)}s` : clock(seconds);
}
