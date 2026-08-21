import { useEffect, useRef, useState } from "react";

/**
 * The transcription as notation.
 *
 * The MusicXML is Mirelo's, not ours — the same transcription it returns as
 * MIDI, engraved by OpenSheetMusicDisplay. Nothing here re-derives note values
 * from the note list, which matters: turning performance timings into notation
 * is a whole judgement of its own (what is a triplet, what is a dotted eighth
 * played late) and the transcriber has already made it.
 *
 * The engraver is loaded on demand. It is about a megabyte of vendor code and
 * most sessions never open this tab.
 */
export function Sheet({ musicxmlUrl, caption }: { musicxmlUrl: string; caption: string }) {
  const paper = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("loading the engraver…");

  useEffect(() => {
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
      <div className="sheet-paper" ref={paper} />
    </div>
  );
}
