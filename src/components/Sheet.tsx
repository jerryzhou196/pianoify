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

/** How large the notation is drawn, as a factor on OSMD's natural size.
 *
 *  The page is as wide as the reader's window, so this is the only thing
 *  deciding how big a note actually looks: at the old 0.72 the score was
 *  legible but small, a lot of thin staves stacked in a tall dark tab. 0.94 is
 *  that scaled up by 30% — proportionally, so staves, note heads, stems and
 *  the space between systems all grow together and the engraving keeps its
 *  proportions. It also fits fewer bars on a line, so the score runs taller
 *  than 30% overall; the tab scrolls, and bigger notes are the point. */
const SCALE = 0.94;

/**
 * Centre what was actually engraved on the page.
 *
 * OSMD draws systems from the left of a page as wide as the element it was
 * given, so a score that does not fill that width — a short clip, or a single
 * system — sits against the left edge with all of the leftover width dumped on
 * the right. No engraving rule turns this off, and the systems are laid out
 * inside the SVG rather than as elements CSS could reach, so the page itself is
 * cropped to its contents afterwards and the auto margins in the stylesheet do
 * the rest.
 *
 * The viewBox is where OSMD keeps the zoom: user units in, pixels out. So the
 * crop is measured in viewBox units and the width attribute, which is pixels,
 * has to be scaled back down by the same factor or the score is redrawn at
 * 1:1 — bigger than it was asked to be, and clipped by its own height.
 */
function centre(host: HTMLElement): void {
  for (const svg of Array.from(host.querySelectorAll("svg"))) {
    const page = svg.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
    const width = Number.parseFloat(svg.getAttribute("width") ?? "");
    if (!page || page.length !== 4 || !(page[2] > 0) || !(width > 0)) continue;
    const drawn = svg.getBBox();
    // The score fills the page: there is nothing to centre, and cropping would
    // only shave off the right margin the engraving is entitled to.
    if (!(drawn.width > 0) || drawn.width >= page[2]) continue;
    svg.setAttribute("viewBox", `${drawn.x} ${page[1]} ${drawn.width} ${page[3]}`);
    svg.setAttribute("width", String(drawn.width * (width / page[2])));
  }
}

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
        // The engraver measures the element it is handed and draws that wide,
        // so it is handed one with no padding of its own — see the stylesheet.
        const host = paper.current;
        const osmd = new OpenSheetMusicDisplay(host, {
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
        osmd.zoom = SCALE;

        // Centre after every engraving, not just this one. OSMD re-renders on
        // its own when the window changes size — that reflow is the point of
        // engraving in the browser rather than showing MuseScore's PDF — and it
        // calls `render` to do it, so wrapping the method is what catches those
        // too. A re-render that skipped the centring would drop the score back
        // against the left edge and stay there.
        const engrave = osmd.render.bind(osmd);
        osmd.render = () => {
          engrave();
          centre(host);
        };
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
        <div className="sheet-paper">
          <div className="sheet-engraving" ref={paper} />
        </div>
      ) : (
        <div className="sheet-waiting">{notice}</div>
      )}
    </div>
  );
}
