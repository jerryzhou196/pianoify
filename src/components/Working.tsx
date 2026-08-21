/**
 * What the page shows while Mirelo is working.
 *
 * A strip in the corner of the roll, not a curtain over the page. The notes
 * arrive in batches while the model is still decoding and the roll draws them
 * as they land, so there is something to watch and something to play with —
 * blocking the page would be hiding the most interesting part of the wait.
 *
 * The four bars are decoration; the line under them is not. Uploading, queueing
 * and transcribing fail in different ways and take different amounts of time,
 * and knowing which one is happening is the difference between waiting and
 * wondering.
 */
export function Working({ stage, onCancel }: { stage: string; onCancel: () => void }) {
  return (
    <div className="working">
      <div className="meter">
        <i style={{ height: "100%", animationDuration: "0.62s" }} />
        <i style={{ height: "70%", animationDuration: "0.48s", animationDelay: "0.1s" }} />
        <i style={{ height: "88%", animationDuration: "0.72s", animationDelay: "0.05s" }} />
        <i style={{ height: "56%", animationDuration: "0.55s", animationDelay: "0.16s" }} />
      </div>
      <span className="stage">{stage}</span>
      <button className="ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
