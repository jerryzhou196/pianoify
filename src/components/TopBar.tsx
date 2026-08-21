import { useState } from "react";
import { ModelPicker } from "./ModelPicker";
import type { ModelId } from "../models";

/**
 * The header: which model transcribes, which way of looking at the result is
 * open, what was transcribed, and the two exports.
 *
 * The exports hand over the transcriber's own renderings rather than anything
 * built here, so what lands in a notation editor is what was actually decoded
 * and not this app's re-derivation of it. Mirelo returns both MIDI and
 * MusicXML behind presigned links; the GPU box hands its MIDI over with the
 * notes and its MusicXML a few seconds later, once MuseScore has engraved it.
 * Which is why the sheet-music tab opens on a waiting line rather than staying
 * shut: the wait is the honest state, and it is a short one.
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
  engraving,
}: {
  model: ModelId;
  onModel: (model: ModelId) => void;
  view: "roll" | "sheet";
  onView: (view: "roll" | "sheet") => void;
  fileName: string | null;
  onReplace: () => void;
  midiUrl: string | null;
  musicxmlUrl: string | null;
  /** Where the MusicXML is, when it is written after the notes rather than
   *  with them. See `engraving` in `App.tsx`. */
  engraving: "idle" | "running" | "failed";
}) {
  const [saving, setSaving] = useState<string | null>(null);

  /** Why a MusicXML-shaped control is dead, when it is. The box engraves in a
   *  second pass after the notes, so for a few seconds the answer is "not yet"
   *  rather than "not at all", and sometimes it is "it could not". */
  const noXml =
    engraving === "running"
      ? "engraving — a few seconds"
      : engraving === "failed"
        ? "the box could not engrave this one"
        : "transcribe something first";

  /** The tab opens on anything the sheet-music panel can say for itself —
   *  a page, a wait, or the reason there will not be one. It is shut only when
   *  there is nothing to tell. */
  const sheetOpens = musicxmlUrl !== null || engraving !== "idle";

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
      <ModelPicker model={model} onModel={onModel} />

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
          disabled={!sheetOpens}
          title={sheetOpens ? undefined : noXml}
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
