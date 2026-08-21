import { useEffect, useRef, useState } from "react";
import { MODELS, modelById, type ModelId } from "../models";

/**
 * The header: which model transcribes, which way of looking at the result is
 * open, what was transcribed, and the two exports.
 *
 * The exports hand over the transcriber's own renderings rather than anything
 * built here, so what lands in a notation editor is what was actually decoded
 * and not this app's re-derivation of it. Mirelo returns both MIDI and
 * MusicXML behind presigned links; the GPU box writes MIDI only, and leaves
 * the MusicXML export and the sheet-music tab disabled.
 */
export function TopBar({
  model,
  onModel,
  view,
  onView,
  fileName,
  onReplace,
  midiUrl,
  musicxmlUrl,
}: {
  model: ModelId;
  onModel: (model: ModelId) => void;
  view: "roll" | "sheet";
  onView: (view: "roll" | "sheet") => void;
  fileName: string | null;
  onReplace: () => void;
  midiUrl: string | null;
  musicxmlUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // Close the menu on anything that is not the menu — a click elsewhere or
  // Escape. Without this it survives a click on the roll behind it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!picker.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = modelById(model);
  /** Why the two MusicXML-shaped controls are dead, when they are. The box
   *  writes MIDI and nothing else, so "transcribe something first" would be
   *  advice that does not work. */
  const noXml =
    current.backend === "muscriptor"
      ? "the gpu box writes MIDI only — transcribe with Mirelo to engrave"
      : "transcribe something first";

  /** Save one of the transcription's own files under a name that means
   *  something.
   *
   *  Fetched into a blob rather than linked to directly: the presigned URL ends
   *  in `transcription.mid` for every transcription anyone has ever run, and a
   *  cross-origin `download` attribute is ignored, so a plain link would leave
   *  a folder full of identically named files. */
  const save = async (url: string, extension: string) => {
    setSaving(extension);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`storage answered ${resp.status}`);
      const blob = await resp.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `${(fileName ?? "transcription").replace(/\.[^.]+$/, "")}.${extension}`;
      a.click();
      // Revoked on the next tick: revoking synchronously can beat the click.
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      // The links expire an hour after the transcription. Nothing to do about
      // it from here but say so where the button was.
      setSaving(null);
      window.alert("that download link has expired — transcribe the clip again");
      return;
    }
    setSaving(null);
  };

  return (
    <header className="bar">
      <div className="picker" ref={picker}>
        <button
          className="chip"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="dot" />
          <span>{current.name}</span>
          <span className="caret">▾</span>
        </button>
        {open && (
          <div className="picker-menu" role="listbox">
            {MODELS.map((m) => (
              <button
                key={m.id}
                className="picker-option"
                role="option"
                aria-selected={m.id === model}
                onClick={() => {
                  onModel(m.id);
                  setOpen(false);
                }}
              >
                <span className="head">
                  <span className="name">{m.name}</span>
                  <span className="tag">{m.tag}</span>
                </span>
                <span className="note">{m.note}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="tabs" role="tablist">
        <button
          className="tab"
          role="tab"
          aria-selected={view === "roll"}
          onClick={() => onView("roll")}
        >
          Piano roll
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={view === "sheet"}
          onClick={() => onView("sheet")}
          disabled={!musicxmlUrl}
          title={musicxmlUrl ? undefined : noXml}
        >
          Sheet music
        </button>
      </div>

      <div className="bar-file">
        <span className="name">{fileName ?? "nothing loaded"}</span>
        <button className="ghost" onClick={onReplace}>
          {fileName ? "Replace" : "Open"}
        </button>
      </div>

      <button
        className="action"
        disabled={!musicxmlUrl || saving !== null}
        title={musicxmlUrl ? undefined : noXml}
        onClick={() => musicxmlUrl && void save(musicxmlUrl, "musicxml")}
      >
        {saving === "musicxml" ? "Saving…" : "Export MusicXML"}
      </button>
      <button
        className="action primary"
        disabled={!midiUrl || saving !== null}
        onClick={() => midiUrl && void save(midiUrl, "mid")}
      >
        {saving === "mid" ? "Saving…" : "Export MIDI"}
      </button>
    </header>
  );
}
