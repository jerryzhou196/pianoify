import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CLIP_SECONDS } from "../config";
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
import type { Model } from "../models";
import { clock } from "../roll";

/**
 * Choosing what to transcribe.
 *
 * The file is decoded here, in the browser, before anything is sent — which is
 * what makes the rest of this panel possible. The waveform is that decode; the
 * window slides over it; the play button previews exactly what will be sent;
 * and the credits under the button are quoted for that window.
 *
 * The window is a fixed ten seconds, not two handles. Ten seconds is the cap
 * (`api/asset` measures the WAV and refuses anything longer), so a handle that
 * can be dragged to eleven is a handle whose only remaining job is to be
 * wrong. What is actually worth choosing is *which* ten seconds — so that is
 * the only thing there is to choose.
 */
export function UploadModal({
  onStart,
  canClose,
  model,
}: {
  onStart: (source: Source, crop: Crop) => void;
  canClose: boolean;
  model: Model;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [crop, setCrop] = useState<Crop>({ a: 0, b: 1 });
  const [hot, setHot] = useState(false);
  const [url, setUrl] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [price, setPrice] = useState<{ credits: number | null; estimated_ms: number | null } | null>(
    null,
  );

  const wave = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  /** Where in the window the pointer grabbed it, as a fraction of the file —
   *  so a drag moves the window with the pointer instead of jumping its start
   *  to wherever the pointer happens to be. */
  const grab = useRef<number | null>(null);
  /** The live crop, for the preview loop and the drag handler, neither of
   *  which can wait for a re-render to see the state they just set. */
  const cropRef = useRef(crop);
  cropRef.current = crop;

  /* ── loading ───────────────────────────────────────────────────────────── */

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

  /* ── sliding the window ────────────────────────────────────────────────── */

  /** How much of the file ten seconds covers. One for a file shorter than the
   *  cap, where the window is the whole thing and there is nothing to slide. */
  const span = source ? Math.min(MAX_CLIP_SECONDS / source.duration, 1) : 1;
  const slidable = span < 1;

  const moveTo = useCallback(
    (start: number) => {
      const a = Math.max(0, Math.min(start, 1 - span));
      setCrop({ a, b: a + span });
    },
    [span],
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const offset = grab.current;
      const rect = wave.current?.getBoundingClientRect();
      if (offset === null || !rect) return;
      moveTo((e.clientX - rect.left) / rect.width - offset);
    };
    const up = () => {
      grab.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [moveTo]);

  /** Grab the window wherever it was clicked; clicking outside it centres it on
   *  the pointer first, so a click at the far end of a long file still gets you
   *  there in one gesture. */
  const startDrag = (e: React.MouseEvent) => {
    const rect = wave.current?.getBoundingClientRect();
    if (!rect || !slidable) return;
    const at = (e.clientX - rect.left) / rect.width;
    const { a } = cropRef.current;
    if (at >= a && at <= a + span) {
      grab.current = at - a;
    } else {
      grab.current = span / 2;
      moveTo(at - span / 2);
    }
  };

  /* ── the preview ───────────────────────────────────────────────────────── */

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

  const togglePreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = audio.current;
    if (!el || !source) return;
    if (!el.paused) {
      el.pause();
      setPlaying(false);
      return;
    }
    const from = crop.a * source.duration;
    // Restart from the top of the window unless the preview was paused inside
    // it, where carrying on is what you meant.
    if (el.currentTime < from || el.currentTime >= crop.b * source.duration) {
      el.currentTime = from;
    }
    void el
      .play()
      .then(() => setPlaying(true))
      .catch(() => {
        // Autoplay policy, or a codec the element cannot stream even though
        // WebAudio decoded it. The waveform is still the important part.
      });
  };

  /* ── the quote ─────────────────────────────────────────────────────────── */

  const window_ = source ? cropSeconds(source, crop) : null;
  const seconds = window_ ? window_.end - window_.start : 0;

  // Only Mirelo has a price to quote — the box is rented by the hour, so a clip
  // on it costs nothing extra and there is nothing to ask before sending it.
  //
  // Re-quoted as the window settles. Debounced, because a drag would otherwise
  // fire a request per frame, and abandoned on the way out so a stale answer
  // cannot land on a newer window.
  useEffect(() => {
    if (!model.billed || !source || seconds <= 0) {
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
  }, [model.billed, source, seconds]);

  /* ── render ────────────────────────────────────────────────────────────── */

  const left = crop.a * 100;
  const right = crop.b * 100;
  // What this clip will cost. Null while an answer is still on its way — the
  // line simply has one fewer thing in it until it lands.
  const cost = !model.billed
    ? "no credits"
    : price?.credits != null
      ? `${price.credits} credits`
      : null;

  return (
    <div className="scrim">
      <div className="modal">
        <div className="modal-head">
          <span className="title">New transcription</span>
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
                <span className="caption">
                  {slidable
                    ? `DRAG THE ${MAX_CLIP_SECONDS}s WINDOW — PLAY TO HEAR IT`
                    : `WHOLE FILE — UNDER ${MAX_CLIP_SECONDS}s`}
                </span>
                <span className="readout">
                  {clock(window_.start)} → {clock(window_.end)} ({seconds.toFixed(1)}s)
                </span>
              </div>

              <div
                className="wave"
                ref={wave}
                data-slidable={slidable ? 1 : 0}
                onMouseDown={startDrag}
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
                <div className="wave-head" ref={head} />
                <button
                  className="wave-play"
                  style={{ left: `${(left + right) / 2}%` }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={togglePreview}
                  title={playing ? "stop the preview" : "preview these seconds"}
                >
                  {playing ? "❚❚" : "▶"}
                </button>
              </div>
            </div>

            <div className="modal-foot">
              <span className="quote">
                {[
                  model.name,
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
                disabled={seconds < 1}
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
