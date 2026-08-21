import { useEffect, useRef, useState } from "react";
import { MODELS, modelById, type ModelId } from "../models";

/**
 * The model menu, in both places you can reach it.
 *
 * It lives in the header, but the header is behind the upload modal and the
 * modal cannot be dismissed — so on a first visit the header's copy is
 * unreachable until after something has been transcribed, which is exactly the
 * wrong time to choose what transcribes it. The modal carries the same picker
 * at the top for that reason. One component, one open/close behaviour, and one
 * piece of state above both of them.
 */
export function ModelPicker({
  model,
  onModel,
}: {
  model: ModelId;
  onModel: (model: ModelId) => void;
}) {
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);

  // Close the menu on anything that is not the menu — a click elsewhere or
  // Escape. Without this it survives a click on whatever is behind it.
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

  return (
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
  );
}
