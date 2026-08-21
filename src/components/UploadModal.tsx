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
import { clock } from "../roll";

/**
 * Choosing what to transcribe.
 *
 * The file is decoded here, in the browser, before anything is sent — which is
 * what makes the rest of this panel possible. The waveform is that decode; the
 * trim handles cut it; the preview plays it; and the credits under the button
 * are quoted for the crop between the handles rather than for the file.
 *
 * The handles open on the most musical window rather than at the start of the
 * file (see `suggestCrop`), because transcription is billed by the second and
 * the first thirty seconds of a recording are usually the least interesting
 * thirty seconds of it. Being able to disagree with that is the point of
 * handles.
 */
export function UploadModal({
  onClose,
  onStart,
  canClose,
  modeLabel,
}: {
  onClose: () => void;
  onStart: (source: Source, crop: Crop) => void;
  canClose: boolean;
  modeLabel: string;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [crop, setCrop] = useState<Crop>({ a: 0, b: 1 });
  const [hot, setHot] = useState(false);
  const [url, setUrl] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState<{ credits: number | null; estimated_ms: number | null } | null>(
    null,
  );

  const wave = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const drag = useRef<"a" | "b" | null>(null);

  /* ── loading ───────────────────────────────────────────────────────────── */

  const load = useCallback(async (file: File) => {
    setError(null);
    setReading(`decoding ${file.name}…`);
    try {
      const decoded = await decodeSource(file);
      setSource(decoded);
      setCrop(suggestCrop(decoded));
      // The preview plays the original file rather than the decoded buffer:
      // an <audio> element already knows how to stream, seek and stop, and the
      // bytes are right here.
      audio.current?.pause();
      if (audio.current?.src) URL.revokeObjectURL(audio.current.src);
      const el = new Audio(URL.createObjectURL(file));
      el.preload = "metadata";
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

  /* ── the handles ───────────────────────────────────────────────────────── */

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const which = drag.current;
      const rect = wave.current?.getBoundingClientRect();
      if (!which || !rect) return;
      const at = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setCrop((c) =>
        which === "a"
          ? { a: Math.min(at, c.b - 0.01), b: c.b }
          : { a: c.a, b: Math.max(at, c.a + 0.01) },
      );
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  /* ── the preview ───────────────────────────────────────────────────────── */

  // The playhead is written straight to the DOM, for the same reason the roll's
  // is: it moves every frame and nothing else in this panel does.
  useEffect(() => {
    if (!source) return;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const el = audio.current;
      if (!el || !head.current) return;
      head.current.style.left = `${Math.min(100, (el.currentTime / source.duration) * 100)}%`;
      head.current.style.opacity = el.paused ? "0.5" : "1";
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [source]);

  const preview = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!source || !audio.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const at = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.current.currentTime = at * source.duration;
    void audio.current.play().catch(() => {
      // Autoplay policy, or a codec the element cannot stream even though
      // WebAudio decoded it. The waveform is still the important part.
    });
  };

  /* ── the quote ─────────────────────────────────────────────────────────── */

  const span = source ? cropSeconds(source, crop) : null;
  const seconds = span ? span.end - span.start : 0;
  const tooLong = seconds > MAX_CLIP_SECONDS;

  // Re-quoted as the handles settle. Debounced, because a drag would otherwise
  // fire a request per frame, and abandoned on the way out so a stale answer
  // cannot land on a newer crop.
  useEffect(() => {
    if (!source || seconds <= 0 || tooLong) {
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
  }, [source, seconds, tooLong]);

  /* ── render ────────────────────────────────────────────────────────────── */

  const percentA = crop.a * 100;
  const percentB = crop.b * 100;

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (canClose && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-head">
          <span className="title">New transcription</span>
          {canClose && (
            <button className="close" onClick={onClose} title="close">
              ✕
            </button>
          )}
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
            {reading ? `${reading}${waited > 2 ? ` ${waited}s` : ""}` : "Drop an audio file, or click to browse"}
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

        <div className="or">
          <div className="rule" />
          <span>OR</span>
          <div className="rule" />
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

        {error && <div className="modal-error">{error}</div>}

        {source && span && (
          <>
            <div className="trim">
              <div className="trim-head">
                <span className="caption">
                  TRIM — {MAX_CLIP_SECONDS}s MAX · DRAG EDGES TO CROP · CLICK TO PREVIEW
                </span>
                <span className="readout">
                  {clock(span.start)} → {clock(span.end)} ({seconds.toFixed(1)}s)
                </span>
              </div>
              <div className="wave" ref={wave} onMouseDown={preview}>
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
                <div className="wave-mask left" style={{ width: `${percentA}%` }} />
                <div className="wave-mask right" style={{ width: `${100 - percentB}%` }} />
                <div
                  className="wave-handle"
                  style={{ left: `${percentA}%` }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    drag.current = "a";
                  }}
                >
                  <i />
                </div>
                <div
                  className="wave-handle"
                  style={{ left: `${percentB}%`, marginLeft: -6 }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    drag.current = "b";
                  }}
                >
                  <i />
                </div>
                <div className="wave-head" ref={head} />
              </div>
            </div>

            <div className="modal-foot">
              <span className="quote">
                {tooLong
                  ? `that crop is ${seconds.toFixed(1)}s — ${MAX_CLIP_SECONDS}s is the most this transcribes at once`
                  : [
                      modeLabel,
                      price?.credits != null ? `${price.credits} credits` : null,
                      price?.estimated_ms != null
                        ? `about ${Math.max(1, Math.round(price.estimated_ms / 1000))}s`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
              <button
                className="go"
                disabled={tooLong || seconds < 1}
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
