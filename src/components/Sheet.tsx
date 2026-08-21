import { useEffect, useRef, useState } from "react";

/**
 * The transcription as notation.
 *
 * The MusicXML is the transcriber's, not ours — the same transcription it
 * returns as MIDI. Mirelo writes it alongside the notes; the GPU box writes it
 * on request, a few seconds behind them (`src/muscriptor.ts`). Either way
 * nothing here re-derives note values from the note list, which matters:
 * turning performance timings into notation is a whole judgement of its own
 * (what is a triplet, what is a dotted eighth played late) and the transcriber
 * has already made it.
 *
 * `notice` is what to say in the meantime, which is why this tab can be open
 * with no page behind it yet: on the box the notes are already on the roll and
 * playing while MuseScore is still laying the score out.
 *
 * The engraver is loaded on demand. It is about a megabyte of vendor code and
 * most sessions never open this tab.
 */
export function Sheet({
  musicxmlUrl,
  caption,
  notice,
}: {
  musicxmlUrl: string | null;
  caption: string;
  notice: string | null;
}) {
  const paper = useRef<HTMLDivElement>(null);
  // The head's right-hand line, which belongs to the engraving: what it is
  // doing, then what it drew. With nothing to draw yet it says nothing, and
  // `notice` has the page to itself below.
  const [status, setStatus] = useState(musicxmlUrl ? "loading the engraver…" : "");

  useEffect(() => {
    // Nothing to engrave yet, or ever — `notice` is what is said instead of a
    // page, and there is no paper to put it on.
    if (!musicxmlUrl) {
      setStatus("");
      return;
    }
    setStatus("loading the engraver…");

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const [{ OpenSheetMusicDisplay }, xml] = await Promise.all([
          import("opensheetmusicdisplay"),
          fetch(musicxmlUrl, { signal: controller.signal }).then((r) => {
            if (!r.ok) throw new Error(`storage answered ${r.status}`);
            return r.text();
          }),
        ]);
        if (cancelled || !paper.current) return;

        setStatus("engraving…");
        const osmd = new OpenSheetMusicDisplay(paper.current, {
          backend: "svg",
          drawTitle: false,
          drawPartNames: false,
          drawMeasureNumbers: true,
          defaultColorMusic: "#000000",
          pageBackgroundColor: "#ffffff",
          drawingParameters: "compacttight",
        });
        await osmd.load(xml);
        if (cancelled) return;
        osmd.zoom = 0.72;
        osmd.render();
        if (!cancelled) setStatus(caption);
      } catch (e) {
        if (cancelled || controller.signal.aborted) return;
        setStatus(`could not engrave that — ${e instanceof Error ? e.message : "unknown error"}`);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      // OSMD writes an SVG straight into the node; React did not put it there
      // and will not take it away.
      if (paper.current) paper.current.innerHTML = "";
    };
  }, [musicxmlUrl, caption]);

  return (
    <div className="sheet">
      <div className="sheet-head">
        <span>ENGRAVED BY OPENSHEETMUSICDISPLAY</span>
        <span>{status}</span>
      </div>
      {musicxmlUrl ? (
        <div className="sheet-paper" ref={paper} />
      ) : (
        <div className="sheet-waiting">{notice}</div>
      )}
    </div>
  );
}
